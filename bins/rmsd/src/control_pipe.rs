use std::borrow::Cow;
use std::time::Duration;

use rms_protocol::v1;

pub const ENDPOINT_PIPE_NAME: &str = r"\\.\pipe\AoE2ControlRmsIdeV1";
pub const MAXIMUM_REQUEST_BYTES: usize = 256 * 1024;
pub const MAXIMUM_RESPONSE_BYTES: u32 = 64 * 1024 * 1024;
pub const MAXIMUM_TIMEOUT_MILLISECONDS: u32 = 60_000;
pub const CHUNK_BYTES: usize = 1024 * 1024;

pub const TEST_PIPE_NAME_VARIABLE: &str = "RMSD_CONTROL_TEST_PIPE_NAME";
pub const TEST_PIPE_PREFIX: &str = r"\\.\pipe\rmsd-control-test-";

pub fn endpoint_pipe_name() -> Cow<'static, str> {
    #[cfg(feature = "internal-fixtures")]
    if let Ok(name) = std::env::var(TEST_PIPE_NAME_VARIABLE)
        && is_test_pipe_name(&name)
    {
        return Cow::Owned(name);
    }
    Cow::Borrowed(ENDPOINT_PIPE_NAME)
}

pub fn is_test_pipe_name(name: &str) -> bool {
    name.len() <= 200
        && name.strip_prefix(TEST_PIPE_PREFIX).is_some_and(|suffix| {
            !suffix.is_empty()
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerCheck {
    Expected,
    OtherProcess,
    Unknown,
}

pub fn check_server_process(expected: u32, observed: Option<u32>) -> ServerCheck {
    match observed {
        _ if expected == 0 => ServerCheck::Unknown,
        None | Some(0) => ServerCheck::Unknown,
        Some(observed) if observed == expected => ServerCheck::Expected,
        Some(_) => ServerCheck::OtherProcess,
    }
}

pub trait ExchangeObserver {
    fn cancelled(&self) -> bool;
    fn chunk(&mut self, data: &[u8]);
}

pub fn validate(request: &v1::ControlPipeExchangeRequest) -> Option<Duration> {
    (request.expected_server_process_id != 0
        && !request.request.is_empty()
        && request.request.len() <= MAXIMUM_REQUEST_BYTES
        && (1..=MAXIMUM_TIMEOUT_MILLISECONDS).contains(&request.timeout_milliseconds)
        && (1..=MAXIMUM_RESPONSE_BYTES).contains(&request.maximum_response_bytes))
    .then(|| Duration::from_millis(u64::from(request.timeout_milliseconds)))
}

pub fn exchange(
    pipe_name: &str,
    request: &v1::ControlPipeExchangeRequest,
    observer: &mut dyn ExchangeObserver,
) -> v1::ControlPipeExchangeResponse {
    let Some(timeout) = validate(request) else {
        return response(v1::ControlPipeExchangeStatus::Invalid, 0);
    };
    #[cfg(windows)]
    {
        let (status, bytes) = platform::exchange(pipe_name, request, timeout, observer);
        response(status, bytes)
    }
    #[cfg(not(windows))]
    {
        let _ = (pipe_name, timeout, observer);
        response(v1::ControlPipeExchangeStatus::Unavailable, 0)
    }
}

fn response(status: v1::ControlPipeExchangeStatus, bytes: u64) -> v1::ControlPipeExchangeResponse {
    v1::ControlPipeExchangeResponse {
        status: status as i32,
        response_bytes: bytes,
    }
}

#[cfg(windows)]
mod platform {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use std::ptr;
    use std::time::{Duration, Instant};

    use rms_protocol::v1::{self, ControlPipeExchangeStatus as Status};
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_PIPE_BUSY,
        ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError, HANDLE,
        INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, SECURITY_IDENTIFICATION,
        SECURITY_SQOS_PRESENT, WriteFile,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};

    use super::{CHUNK_BYTES, ExchangeObserver, ServerCheck, check_server_process};

    const PIPE_RECREATE_GRACE: Duration = Duration::from_millis(500);
    const MAXIMUM_RETRY_DELAY: Duration = Duration::from_millis(100);
    const WAIT_SLICE: Duration = Duration::from_millis(25);
    const READ_BYTES: usize = 64 * 1024;

    struct OwnedHandle(HANDLE);

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    enum Io {
        Done(u32),
        Closed,
        Failed,
        TimedOut,
        Cancelled,
    }

    pub(super) fn exchange(
        pipe_name: &str,
        request: &v1::ControlPipeExchangeRequest,
        timeout: Duration,
        observer: &mut dyn ExchangeObserver,
    ) -> (Status, u64) {
        let started = Instant::now();
        let deadline = started + timeout;
        let name: Vec<u16> = OsStr::new(pipe_name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let pipe = match connect(&name, started, deadline, observer) {
            Ok(pipe) => pipe,
            Err(status) => return (status, 0),
        };
        let mut server = 0_u32;
        let read = unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server) } != 0;
        match check_server_process(request.expected_server_process_id, read.then_some(server)) {
            ServerCheck::Expected => {}
            ServerCheck::OtherProcess => return (Status::ServerProcessMismatch, 0),
            ServerCheck::Unknown => return (Status::ServerProcessUnknown, 0),
        }
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if event.is_null() {
            return (Status::Failed, 0);
        }
        let event = OwnedHandle(event);
        let length = request.request.len() as u32;
        match overlapped(&pipe, &event, deadline, observer, |overlapped| unsafe {
            WriteFile(
                pipe.0,
                request.request.as_ptr(),
                length,
                ptr::null_mut(),
                overlapped,
            )
        }) {
            Io::Done(written) if written == length => {}
            Io::Done(_) | Io::Closed | Io::Failed => return (Status::Failed, 0),
            Io::TimedOut => return (Status::TimedOut, 0),
            Io::Cancelled => return (Status::Cancelled, 0),
        }
        let maximum = u64::from(request.maximum_response_bytes);
        let mut total = 0_u64;
        let mut pending = Vec::with_capacity(READ_BYTES);
        let mut buffer = vec![0_u8; READ_BYTES];
        loop {
            let read = overlapped(&pipe, &event, deadline, observer, |overlapped| unsafe {
                ReadFile(
                    pipe.0,
                    buffer.as_mut_ptr(),
                    READ_BYTES as u32,
                    ptr::null_mut(),
                    overlapped,
                )
            });
            match read {
                Io::Done(bytes) => {
                    total += u64::from(bytes);
                    if total > maximum {
                        return (Status::ResponseTooLarge, total);
                    }
                    pending.extend_from_slice(&buffer[..bytes as usize]);
                    if pending.len() >= CHUNK_BYTES {
                        for chunk in pending.chunks(CHUNK_BYTES) {
                            observer.chunk(chunk);
                        }
                        pending.clear();
                    }
                }
                Io::Closed => {
                    for chunk in pending.chunks(CHUNK_BYTES) {
                        observer.chunk(chunk);
                    }
                    return (Status::Complete, total);
                }
                Io::Failed => return (Status::Failed, total),
                Io::TimedOut => return (Status::TimedOut, total),
                Io::Cancelled => return (Status::Cancelled, total),
            }
        }
    }

    fn connect(
        name: &[u16],
        started: Instant,
        deadline: Instant,
        observer: &dyn ExchangeObserver,
    ) -> Result<OwnedHandle, Status> {
        let mut delay = Duration::from_millis(10);
        loop {
            if observer.cancelled() {
                return Err(Status::Cancelled);
            }
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                return Ok(OwnedHandle(handle));
            }
            let error = unsafe { GetLastError() };
            let now = Instant::now();
            if now >= deadline {
                return Err(Status::Unavailable);
            }
            let remaining = deadline - now;
            if error == ERROR_PIPE_BUSY {
                let wait = remaining.min(MAXIMUM_RETRY_DELAY).as_millis().max(1) as u32;
                unsafe { WaitNamedPipeW(name.as_ptr(), wait) };
            } else if error == ERROR_FILE_NOT_FOUND && now - started < PIPE_RECREATE_GRACE {
                std::thread::sleep(delay.min(remaining));
                delay = (delay * 2).min(MAXIMUM_RETRY_DELAY);
            } else {
                return Err(Status::Unavailable);
            }
        }
    }

    fn overlapped(
        pipe: &OwnedHandle,
        event: &OwnedHandle,
        deadline: Instant,
        observer: &dyn ExchangeObserver,
        start: impl FnOnce(*mut OVERLAPPED) -> i32,
    ) -> Io {
        let mut operation = OVERLAPPED {
            hEvent: event.0,
            ..OVERLAPPED::default()
        };
        let started = start(&mut operation);
        if started == 0 {
            let error = unsafe { GetLastError() };
            if error != ERROR_IO_PENDING {
                return closed_or_failed(error);
            }
        }
        let stop = loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if observer.cancelled() {
                break Io::Cancelled;
            }
            if remaining.is_zero() {
                break Io::TimedOut;
            }
            let slice = remaining.min(WAIT_SLICE).as_millis().max(1) as u32;
            let signal = unsafe { WaitForSingleObject(event.0, slice) };
            if signal == WAIT_TIMEOUT {
                continue;
            }
            if signal != WAIT_OBJECT_0 {
                break Io::Failed;
            }
            let mut transferred = 0_u32;
            if unsafe { GetOverlappedResult(pipe.0, &operation, &mut transferred, 0) } != 0 {
                return Io::Done(transferred);
            }
            return closed_or_failed(unsafe { GetLastError() });
        };
        unsafe {
            CancelIoEx(pipe.0, &operation);
            let mut transferred = 0_u32;
            GetOverlappedResult(pipe.0, &operation, &mut transferred, 1);
        }
        stop
    }

    fn closed_or_failed(error: u32) -> Io {
        if error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED {
            Io::Closed
        } else {
            Io::Failed
        }
    }
}
