use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectResourceSlot {
    pub resource_type: i16,
    pub quantity_f32_bits: u32,
    pub mode: u8,
}

impl ObjectResourceSlot {
    pub const EMPTY: Self = Self {
        resource_type: -1,
        quantity_f32_bits: 0,
        mode: 0,
    };

    pub fn has_finite_quantity(self) -> bool {
        f32::from_bits(self.quantity_f32_bits).is_finite()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObjectResourceState {
    pub resource_type: i16,
    pub quantity_f32_bits: u32,
}

impl ObjectResourceState {
    pub const EMPTY: Self = Self {
        resource_type: -1,
        quantity_f32_bits: 0,
    };

    pub fn adjust_quantity(&mut self, delta: i32) {
        if delta != 0 {
            self.quantity_f32_bits =
                (delta as f32 + f32::from_bits(self.quantity_f32_bits)).to_bits();
        }
    }

    pub fn from_slots(slots: &[ObjectResourceSlot; 3]) -> Self {
        let mut state = Self::EMPTY;
        for slot in slots {
            if slot.mode == 0 && slot.resource_type != -1 {
                state = Self {
                    resource_type: slot.resource_type,
                    quantity_f32_bits: slot.quantity_f32_bits,
                };
            }
        }
        state
    }
}
