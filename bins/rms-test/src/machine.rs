use std::num::NonZero;

pub const MAX_WORKERS: usize = 32;

pub const SYSTEM_MEMORY_HEADROOM_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkerSetting {
    Auto,
    Fixed(usize),
}

impl WorkerSetting {
    pub fn validate(self) -> Result<(), String> {
        match self {
            Self::Auto => Ok(()),
            Self::Fixed(count) if (1..=MAX_WORKERS).contains(&count) => Ok(()),
            Self::Fixed(_) => Err(format!("workers must be between 1 and {MAX_WORKERS}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct MachineResources {
    pub logical_processors: usize,
    pub available_memory_bytes: u64,
}

impl MachineResources {
    pub fn detect() -> Self {
        Self {
            logical_processors: std::thread::available_parallelism().map_or(1, NonZero::get),
            available_memory_bytes: available_physical_memory()
                .unwrap_or(FALLBACK_AVAILABLE_MEMORY_BYTES),
        }
    }
}

const FALLBACK_AVAILABLE_MEMORY_BYTES: u64 = 4 * 1024 * 1024 * 1024;

pub const WORKER_PEAK_BASE_BYTES: u64 = 16 * 1024 * 1024;
pub const WORKER_PEAK_BYTES_PER_TILE: u64 = 768;

pub fn estimated_worker_peak_bytes(tiles: u64) -> u64 {
    WORKER_PEAK_BASE_BYTES.saturating_add(tiles.saturating_mul(WORKER_PEAK_BYTES_PER_TILE))
}

pub fn processor_workers(logical_processors: usize) -> usize {
    let reserve = (logical_processors / 8).max(1);
    logical_processors
        .saturating_sub(reserve)
        .clamp(1, MAX_WORKERS)
}

pub fn plan_workers(
    setting: WorkerSetting,
    machine: MachineResources,
    peak_bytes: u64,
    child_budget_bytes: u64,
    samples: usize,
) -> usize {
    let requested = match setting {
        WorkerSetting::Auto => processor_workers(machine.logical_processors),
        WorkerSetting::Fixed(count) => count.clamp(1, MAX_WORKERS),
    };
    let peak = peak_bytes.max(1);
    let system = machine
        .available_memory_bytes
        .saturating_sub(SYSTEM_MEMORY_HEADROOM_BYTES)
        / peak;
    let child = child_budget_bytes / peak;
    let memory = usize::try_from(system.min(child)).unwrap_or(usize::MAX);
    requested.min(memory).min(samples).max(1)
}

pub fn lower_thread_priority() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
        };
        unsafe {
            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL);
        }
    }
}

#[cfg(windows)]
fn available_physical_memory() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
    let mut status = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..MEMORYSTATUSEX::default()
    };
    let succeeded = unsafe { GlobalMemoryStatusEx(&mut status) };
    (succeeded != 0).then_some(status.ullAvailPhys)
}

#[cfg(not(windows))]
fn available_physical_memory() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let line = meminfo
        .lines()
        .find(|line| line.starts_with("MemAvailable:"))?;
    let kib = line.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    kib.checked_mul(1024)
}
