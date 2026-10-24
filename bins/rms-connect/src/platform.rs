use std::io;
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OpenError {
    NotFound,
    Busy,
    Other,
}

#[cfg(windows)]
pub use windows::{Pipe, fill_random, parent_image_name, process_image};

#[cfg(windows)]
mod windows {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::ptr;

    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING, ERROR_MORE_DATA,
        ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, GENERIC_READ, GENERIC_WRITE, GetLastError,
        HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
    };
    use windows_sys::Win32::Security::Cryptography::{
        BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, OPEN_EXISTING, ReadFile, SECURITY_IDENTIFICATION,
        SECURITY_SQOS_PRESENT, WriteFile,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED};
    use windows_sys::Win32::System::Pipes::{GetNamedPipeServerProcessId, WaitNamedPipeW};
    use windows_sys::Win32::System::Threading::{
        CreateEventW, GetCurrentProcessId, INFINITE, OpenProcess, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW, SetEvent,
        WaitForMultipleObjects,
    };

    use super::{Duration, Instant, OpenError, PathBuf, io};

    const MAXIMUM_BUSY_WAIT_SLICE: Duration = Duration::from_millis(100);

    struct Handle(HANDLE);

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    pub struct Pipe {
        handle: Handle,
        read_event: Handle,
        write_event: Handle,
        stop_event: Handle,
    }

    unsafe impl Send for Pipe {}
    unsafe impl Sync for Pipe {}

    fn event() -> io::Result<Handle> {
        let event = unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) };
        if event.is_null() {
            Err(io::Error::last_os_error())
        } else {
            Ok(Handle(event))
        }
    }

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    impl Pipe {
        pub fn open(name: &str, busy_wait: Duration) -> Result<Self, OpenError> {
            let name = wide(name.as_ref());
            let deadline = Instant::now() + busy_wait;
            loop {
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
                    let handle = Handle(handle);
                    return Ok(Self {
                        handle,
                        read_event: event().map_err(|_| OpenError::Other)?,
                        write_event: event().map_err(|_| OpenError::Other)?,
                        stop_event: event().map_err(|_| OpenError::Other)?,
                    });
                }
                let error = unsafe { GetLastError() };
                let now = Instant::now();
                match error {
                    ERROR_FILE_NOT_FOUND => return Err(OpenError::NotFound),
                    ERROR_PIPE_BUSY if now < deadline => {
                        let slice = (deadline - now).min(MAXIMUM_BUSY_WAIT_SLICE);
                        unsafe { WaitNamedPipeW(name.as_ptr(), slice.as_millis().max(1) as u32) };
                    }
                    ERROR_PIPE_BUSY => return Err(OpenError::Busy),
                    _ => return Err(OpenError::Other),
                }
            }
        }

        pub fn server_process_id(&self) -> Option<u32> {
            let mut process = 0_u32;
            let read = unsafe { GetNamedPipeServerProcessId(self.handle.0, &mut process) } != 0;
            (read && process != 0).then_some(process)
        }

        pub fn read(&self, buffer: &mut [u8], deadline: Option<Instant>) -> io::Result<usize> {
            let length = buffer.len().min(u32::MAX as usize) as u32;
            let pointer = buffer.as_mut_ptr();
            match self.overlapped(&self.read_event, deadline, |operation| unsafe {
                ReadFile(self.handle.0, pointer, length, ptr::null_mut(), operation)
            }) {
                Ok(read) => Ok(read as usize),
                Err((ERROR_MORE_DATA, read)) => Ok(read as usize),
                Err((ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED, _)) => Ok(0),
                Err((code, _)) => Err(error(code)),
            }
        }

        pub fn write(&self, bytes: &[u8], deadline: Instant) -> io::Result<usize> {
            let length = bytes.len().min(u32::MAX as usize) as u32;
            match self.overlapped(&self.write_event, Some(deadline), |operation| unsafe {
                WriteFile(
                    self.handle.0,
                    bytes.as_ptr(),
                    length,
                    ptr::null_mut(),
                    operation,
                )
            }) {
                Ok(written) => Ok(written as usize),
                Err((ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED, _)) => {
                    Err(io::ErrorKind::BrokenPipe.into())
                }
                Err((code, _)) => Err(error(code)),
            }
        }

        pub fn stop(&self) {
            unsafe { SetEvent(self.stop_event.0) };
        }

        fn overlapped(
            &self,
            event: &Handle,
            deadline: Option<Instant>,
            start: impl FnOnce(*mut OVERLAPPED) -> i32,
        ) -> Result<u32, (u32, u32)> {
            let mut operation = OVERLAPPED {
                hEvent: event.0,
                ..OVERLAPPED::default()
            };
            if start(&mut operation) == 0 {
                let code = unsafe { GetLastError() };
                if code != ERROR_IO_PENDING {
                    return Err((code, 0));
                }
            }
            let events = [event.0, self.stop_event.0];
            let timeout = deadline.map_or(INFINITE, |deadline| {
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_millis()
                    .min(u128::from(INFINITE - 1)) as u32
            });
            let signal = unsafe { WaitForMultipleObjects(2, events.as_ptr(), 0, timeout) };
            let mut moved = 0_u32;
            if signal == WAIT_OBJECT_0 {
                if unsafe { GetOverlappedResult(self.handle.0, &operation, &mut moved, 0) } != 0 {
                    return Ok(moved);
                }
                return Err((unsafe { GetLastError() }, moved));
            }
            unsafe {
                CancelIoEx(self.handle.0, &operation);
                GetOverlappedResult(self.handle.0, &operation, &mut moved, 1);
            }
            let code = if signal == WAIT_TIMEOUT {
                TIMED_OUT
            } else {
                STOPPED
            };
            Err((code, moved))
        }
    }

    const TIMED_OUT: u32 = u32::MAX;
    const STOPPED: u32 = u32::MAX - 1;

    fn error(code: u32) -> io::Error {
        match code {
            TIMED_OUT => io::ErrorKind::TimedOut.into(),
            STOPPED => io::ErrorKind::ConnectionAborted.into(),
            code => io::Error::from_raw_os_error(code as i32),
        }
    }

    pub fn process_image(process: u32) -> Option<PathBuf> {
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process) };
        if handle.is_null() {
            return None;
        }
        let handle = Handle(handle);
        let mut buffer = vec![0_u16; 32_768];
        let mut length = buffer.len() as u32;
        let read = unsafe {
            QueryFullProcessImageNameW(
                handle.0,
                PROCESS_NAME_WIN32,
                buffer.as_mut_ptr(),
                &mut length,
            )
        } != 0;
        (read && length > 0).then(|| PathBuf::from(OsString::from_wide(&buffer[..length as usize])))
    }

    pub fn parent_image_name() -> String {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return String::new();
        }
        let snapshot = Handle(snapshot);
        let own = unsafe { GetCurrentProcessId() };
        let mut processes = Vec::new();
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..PROCESSENTRY32W::default()
        };
        let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
        while more {
            let length = entry
                .szExeFile
                .iter()
                .position(|unit| *unit == 0)
                .unwrap_or(entry.szExeFile.len());
            processes.push((
                entry.th32ProcessID,
                entry.th32ParentProcessID,
                String::from_utf16_lossy(&entry.szExeFile[..length]),
            ));
            more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
        }
        let Some(parent) = processes
            .iter()
            .find(|(process, _, _)| *process == own)
            .map(|(_, parent, _)| *parent)
        else {
            return String::new();
        };
        processes
            .into_iter()
            .find(|(process, _, _)| *process == parent && parent != 0)
            .map(|(_, _, name)| name)
            .unwrap_or_default()
    }

    pub fn fill_random(buffer: &mut [u8]) -> io::Result<()> {
        let status = unsafe {
            BCryptGenRandom(
                ptr::null_mut(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if status == 0 {
            Ok(())
        } else {
            Err(io::Error::other("the system random generator failed"))
        }
    }
}

#[cfg(not(windows))]
pub use other::{Pipe, fill_random, parent_image_name, process_image};

#[cfg(not(windows))]
mod other {
    use super::{Duration, Instant, OpenError, PathBuf, io};

    pub struct Pipe;

    impl Pipe {
        pub fn open(_name: &str, _busy_wait: Duration) -> Result<Self, OpenError> {
            Err(OpenError::NotFound)
        }

        pub fn server_process_id(&self) -> Option<u32> {
            None
        }

        pub fn read(&self, _buffer: &mut [u8], _deadline: Option<Instant>) -> io::Result<usize> {
            Ok(0)
        }

        pub fn write(&self, _bytes: &[u8], _deadline: Instant) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        pub fn stop(&self) {}
    }

    pub fn process_image(_process: u32) -> Option<PathBuf> {
        None
    }

    pub fn parent_image_name() -> String {
        String::new()
    }

    pub fn fill_random(buffer: &mut [u8]) -> io::Result<()> {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")?.read_exact(buffer)
    }
}
