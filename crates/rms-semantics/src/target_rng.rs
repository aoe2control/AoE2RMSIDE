use sha2::{Digest, Sha256};
use thiserror::Error;

const STATE_WORD_COUNT: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RmsRngState {
    words: [u32; STATE_WORD_COUNT],
    index: u8,
    draws: u64,
}

impl RmsRngState {
    pub fn words(self) -> [u32; STATE_WORD_COUNT] {
        self.words
    }

    pub fn index(self) -> u8 {
        self.index
    }

    pub fn draws(self) -> u64 {
        self.draws
    }

    pub fn checkpoint_hash(self) -> [u8; 32] {
        let mut hasher = Sha256::new();
        hasher.update(b"rms-rng-checkpoint-v1");
        hasher.update([self.index]);
        hasher.update(self.draws.to_le_bytes());
        for word in self.words {
            hasher.update(word.to_le_bytes());
        }
        hasher.finalize().into()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RmsRngSample {
    pub ordinal: u64,
    pub raw: u32,
    pub upper_exclusive: u32,
    pub result: u32,
    state: RmsRngState,
}

impl RmsRngSample {
    pub fn checkpoint_hash(&self) -> [u8; 32] {
        self.state.checkpoint_hash()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RmsRngPurpose {
    ParserRandomBranch,
    ParserNumericRange,
    LandAssignmentSelection,
    LandZoneRandomization,
}

impl RmsRngPurpose {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ParserRandomBranch => "parser-random-branch",
            Self::ParserNumericRange => "parser-numeric-range",
            Self::LandAssignmentSelection => "land-assignment-selection",
            Self::LandZoneRandomization => "land-zone-randomization",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RmsRngDraw {
    pub purpose: RmsRngPurpose,
    pub sample: RmsRngSample,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RmsRandom {
    state: RmsRngState,
}

impl RmsRandom {
    pub const RANDOM_MAP_REGISTRATION_ORDINAL: u8 = 2;

    pub fn random_map(global_seed: u32) -> Self {
        Self::registered(global_seed, Self::RANDOM_MAP_REGISTRATION_ORDINAL)
            .expect("the random-map stream registration ordinal is valid")
    }

    pub fn registered(global_seed: u32, registration_ordinal: u8) -> Option<Self> {
        if registration_ordinal == 0 || registration_ordinal > 64 {
            return None;
        }
        let mut seed = global_seed;
        for stream_index in 0..registration_ordinal {
            let mut stream = Self::from_seed(seed);
            seed = stream.next_u32();
            if stream_index + 1 == registration_ordinal {
                return Some(stream);
            }
        }
        None
    }

    pub fn from_state(state: RmsRngState) -> Self {
        Self { state }
    }

    fn from_seed(seed: u32) -> Self {
        let mut words = [0_u32; STATE_WORD_COUNT];
        let mut x = seed.swap_bytes() ^ 0xAAC2_9377;
        let mut mixed = seed;
        for item in &mut words {
            x = xorshift_seed(x);
            mixed = mix_seed(mixed);
            *item = x ^ mixed;
        }
        Self {
            state: RmsRngState {
                words,
                index: 0,
                draws: 0,
            },
        }
    }

    pub fn state(&self) -> RmsRngState {
        self.state
    }

    pub fn with_observed_draw_count(mut self, draws: u64) -> Self {
        self.state.draws = draws;
        self
    }

    pub fn next_u32(&mut self) -> u32 {
        let index = usize::from(self.state.index);
        let prior_three = self.state.words[index.wrapping_sub(3) & 0x0f];
        let a = self.state.words[index];
        let v2 = a ^ prior_three ^ ((prior_three ^ a.wrapping_mul(2)) << 15);
        let prior_seven = self.state.words[index.wrapping_sub(7) & 0x0f];
        let v3 = prior_seven ^ (prior_seven >> 11);
        let v4 = v2 ^ (v3 << 10);
        let v5 = v2 ^ v3;
        self.state.words[index] = v5;
        self.state.index = self.state.index.wrapping_sub(1) & 0x0f;
        let next_index = usize::from(self.state.index);
        let current = self.state.words[next_index];
        self.state.words[next_index] ^= v2
            ^ v5
            ^ (current ^ 8_u32.wrapping_mul((v5 & 0xFED2_2169) ^ (v4 << 13))).wrapping_mul(4);
        self.state.draws = self.state.draws.wrapping_add(1);
        self.state.words[next_index]
    }

    pub fn bounded(&mut self, upper_exclusive: u32) -> RmsRngSample {
        let raw = self.next_u32();
        let result = ((u64::from(upper_exclusive) * u64::from(raw)) >> 32) as u32;
        RmsRngSample {
            ordinal: self.state.draws,
            raw,
            upper_exclusive,
            result,
            state: self.state,
        }
    }

    pub fn signed_inclusive(
        &mut self,
        minimum: i32,
        maximum: i32,
    ) -> Result<(i32, RmsRngSample), RmsRngError> {
        let width = i64::from(maximum)
            .checked_sub(i64::from(minimum))
            .and_then(|value| value.checked_add(1))
            .and_then(|value| u32::try_from(value).ok())
            .filter(|value| *value > 0)
            .ok_or(RmsRngError::InvalidSignedRange { minimum, maximum })?;
        let sample = self.bounded(width);
        let value = i64::from(minimum) + i64::from(sample.result);
        Ok((
            i32::try_from(value).expect("a sample within a valid signed range remains an i32"),
            sample,
        ))
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum RmsRngError {
    #[error("invalid inclusive signed RMS RNG range {minimum}..={maximum}")]
    InvalidSignedRange { minimum: i32, maximum: i32 },
}

fn xorshift_seed(value: u32) -> u32 {
    let value = value ^ (value << 17);
    let value = value ^ (value >> 13);
    value ^ (value << 5)
}

fn mix_seed(value: u32) -> u32 {
    let value = 4097_u32.wrapping_mul(value).wrapping_add(2_127_912_214);
    let value = value ^ (value >> 19) ^ 0xC761_C23C;
    let multiplied = 33_u32.wrapping_mul(value);
    let value =
        multiplied.wrapping_sub(369_570_787) ^ multiplied.wrapping_add(374_761_393).wrapping_shl(9);
    let value = 9_u32.wrapping_mul(value).wrapping_sub(42_973_499);
    value ^ (value >> 16) ^ 0xB55A_4F09
}
