const XS_STREAM_DOMAIN: u64 = 0x5853_5f53_5441_5254;

#[derive(Clone, Debug)]
pub struct XsRandom {
    state: u64,
}

impl XsRandom {
    pub fn new(map_seed: i64) -> Self {
        Self {
            state: (map_seed as u64) ^ XS_STREAM_DOMAIN,
        }
    }

    fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut value = self.state;
        value = (value ^ (value >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        value = (value ^ (value >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        value ^ (value >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        let zone = u64::MAX - (u64::MAX % bound);
        loop {
            let value = self.next_u64();
            if value < zone {
                return value % bound;
            }
        }
    }

    pub fn number(&mut self) -> i32 {
        self.below(32_768) as i32
    }

    pub fn low_high(&mut self, low: i32, high: i32) -> i32 {
        if high <= low {
            return low;
        }
        let span = (high as i64 - low as i64) as u64;
        (low as i64 + self.below(span) as i64) as i32
    }

    pub fn max(&mut self, max: i32) -> i32 {
        if max <= 0 {
            return 0;
        }
        self.below(max as u64) as i32
    }
}
