use rms_source::ByteRange;

use crate::interp::{ArrayData, Exec, FindingSeverity, Machine, Topic};
use crate::value::{Value, ValueKind, float_to_int};
use crate::{MAXIMUM_ARRAY_ITEMS, MAXIMUM_ARRAYS};

fn array_type(name: &str) -> Option<ValueKind> {
    Some(if name.ends_with("Int") {
        ValueKind::Int
    } else if name.ends_with("Float") {
        ValueKind::Float
    } else if name.ends_with("Bool") {
        ValueKind::Bool
    } else if name.ends_with("String") {
        ValueKind::Str
    } else if name.ends_with("Vector") {
        ValueKind::Vector
    } else {
        return None;
    })
}

fn array_default(kind: ValueKind) -> Value {
    match kind {
        ValueKind::Int => Value::Int(-1),
        ValueKind::Float => Value::Float(-1.0),
        ValueKind::Bool => Value::Bool(false),
        ValueKind::Str => Value::text(""),
        _ => Value::Vector([0.0; 3]),
    }
}

fn int(args: &[Value], index: usize) -> i32 {
    match args.get(index) {
        Some(Value::Int(value)) => *value,
        Some(Value::Bool(value)) => i32::from(*value),
        Some(Value::Float(value)) => float_to_int(*value).0,
        _ => 0,
    }
}

fn float(args: &[Value], index: usize) -> f32 {
    args.get(index).and_then(Value::as_f32).unwrap_or_default()
}

fn vector(args: &[Value], index: usize) -> [f32; 3] {
    match args.get(index) {
        Some(Value::Vector(value)) => *value,
        _ => [0.0; 3],
    }
}

fn bytes(args: &[Value], index: usize) -> &[u8] {
    args.get(index)
        .and_then(Value::as_bytes)
        .unwrap_or_default()
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return (from <= haystack.len()).then_some(from);
    }
    if from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| position + from)
}

fn rfind(haystack: &[u8], needle: &[u8], last_start: usize) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    let last = last_start.min(haystack.len() - needle.len());
    (0..=last)
        .rev()
        .find(|start| &haystack[*start..*start + needle.len()] == needle)
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c)
}

fn parse_int(text: &[u8], base: u32) -> Option<i32> {
    if !(2..=36).contains(&base) {
        return None;
    }
    let (negative, digits) = match text.first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    if digits.is_empty() {
        return None;
    }
    let mut value: i64 = 0;
    for byte in digits {
        let digit = (*byte as char).to_digit(base)?;
        value = value * i64::from(base) + i64::from(digit);
        if value > i64::from(i32::MAX) + 1 {
            return None;
        }
    }
    let value = if negative { -value } else { value };
    i32::try_from(value).ok()
}

fn parse_bits(text: &[u8], base: u32) -> Option<i32> {
    let prefix: &[u8] = if base == 16 { b"0x" } else { b"0b" };
    let digits = if text.len() >= 2 && text[..2].eq_ignore_ascii_case(prefix) {
        &text[2..]
    } else {
        text
    };
    let mut value: u64 = 0;
    let mut count = 0;
    for byte in digits {
        if *byte == b'\'' {
            continue;
        }
        let digit = (*byte as char).to_digit(base)?;
        value = value * u64::from(base) + u64::from(digit);
        if value > u64::from(u32::MAX) {
            return None;
        }
        count += 1;
    }
    (count > 0).then_some(value as u32 as i32)
}

fn parse_float(text: &[u8]) -> Option<f32> {
    let text = std::str::from_utf8(text).ok()?;
    let body = text.strip_prefix(['-', '+']).unwrap_or(text);
    let (mantissa, exponent) = match body.find(['e', 'E']) {
        Some(index) => (&body[..index], Some(&body[index + 1..])),
        None => (body, None),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits = |part: &str| part.bytes().all(|byte| byte.is_ascii_digit());
    if (whole.is_empty() && fraction.is_empty()) || !digits(whole) || !digits(fraction) {
        return None;
    }
    if let Some(exponent) = exponent {
        let exponent = exponent.strip_prefix(['-', '+']).unwrap_or(exponent);
        if exponent.is_empty() || !digits(exponent) {
            return None;
        }
    }
    text.parse::<f32>().ok()
}

impl<'p> Machine<'p> {
    pub(crate) fn pure_builtin(
        &mut self,
        name: &str,
        args: &[Value],
        range: ByteRange,
    ) -> Exec<Value> {
        let f = |index| float(args, index);
        Ok(match name {
            "abs" => Value::Float(f(0).abs()),
            "acos" => Value::Float(f(0).acos()),
            "asin" => Value::Float(f(0).asin()),
            "atan" => Value::Float(f(0).atan()),
            "atan2" => Value::Float(f(0).atan2(f(1))),
            "atan2v" => {
                let [x, y, _] = vector(args, 0);
                Value::Float(y.atan2(x))
            }
            "ceil" => Value::Float(f(0).ceil()),
            "floor" => Value::Float(f(0).floor()),
            "cos" => Value::Float(f(0).cos()),
            "sin" => Value::Float(f(0).sin()),
            "tan" => Value::Float(f(0).tan()),
            "degrees" => Value::Float(f(0).to_degrees()),
            "radians" => Value::Float(f(0).to_radians()),
            "exp" => Value::Float(f(0).exp()),
            "ln" => Value::Float(f(0).ln()),
            "log10" => Value::Float(f(0).log10()),
            "log2" => Value::Float(f(0).log2()),
            "pow" => Value::Float(f(0).powf(f(1))),
            "sqrt" => Value::Float(f(0).sqrt()),
            "round" => {
                let places = int(args, 1).clamp(0, 8);
                let scale = 10f64.powi(places);
                Value::Float(((f64::from(f(0)) * scale).round() / scale) as f32)
            }
            "dist" => {
                let a = vector(args, 0);
                let b = vector(args, 1);
                Value::Float(length([a[0] - b[0], a[1] - b[1], a[2] - b[2]]))
            }
            "xsCeilToInt" => {
                let (value, unusual) = float_to_int(f(0).ceil());
                if unusual {
                    self.topics.insert(Topic::IntegerArithmetic);
                }
                Value::Int(value)
            }
            "bitCastToFloat" => Value::Float(f32::from_bits(int(args, 0) as u32)),
            "bitCastToInt" => Value::Int(f(0).to_bits() as i32),
            "bitAnd" => Value::Int(int(args, 0) & int(args, 1)),
            "bitOr" => Value::Int(int(args, 0) | int(args, 1)),
            "bitXor" => Value::Int(int(args, 0) ^ int(args, 1)),
            "bitNot" => Value::Int(!int(args, 0)),
            "bitLsh" | "bitRsh" => {
                let value = int(args, 0);
                let shift = int(args, 1);
                if !(0..32).contains(&shift) {
                    self.topics.insert(Topic::IntegerArithmetic);
                    Value::Int(if name == "bitRsh" && value < 0 { -1 } else { 0 })
                } else if name == "bitLsh" {
                    Value::Int(value << shift)
                } else {
                    Value::Int(value >> shift)
                }
            }
            "xsVectorGetX" => Value::Float(vector(args, 0)[0]),
            "xsVectorGetY" => Value::Float(vector(args, 0)[1]),
            "xsVectorGetZ" => Value::Float(vector(args, 0)[2]),
            "xsVectorLength" => Value::Float(length(vector(args, 0))),
            "xsVectorNormalize" => {
                let v = vector(args, 0);
                let size = length(v);
                if size == 0.0 || !size.is_finite() {
                    Value::Vector([0.0; 3])
                } else {
                    Value::Vector(v.map(|part| part / size))
                }
            }
            "xsVectorSet" => Value::Vector([f(0), f(1), f(2)]),
            "xsVectorSetX" | "xsVectorSetY" | "xsVectorSetZ" => {
                let mut v = vector(args, 0);
                let index = match name {
                    "xsVectorSetX" => 0,
                    "xsVectorSetY" => 1,
                    _ => 2,
                };
                v[index] = f(1);
                Value::Vector(v)
            }
            "xsBreakPoint" | "xsDumpArrays" => Value::Void,
            "xsGetContextPlayer" => match self.context_player {
                Some(player) => Value::Int(player),
                None => {
                    self.topics.insert(Topic::StartDefaults);
                    Value::Int(0)
                }
            },
            "xsSetContextPlayer" => {
                self.context_player = Some(int(args, 0));
                Value::Void
            }
            "xsGetFunctionID" => {
                let wanted = String::from_utf8_lossy(bytes(args, 0)).into_owned();
                Value::Int(self.program_function_id(&wanted))
            }
            _ if name.starts_with("xsArray") => return self.array_builtin(name, args, range),
            _ if name.starts_with("xs") => return Ok(self.rule_builtin(name, args)),
            _ => return self.text_builtin(name, args, range),
        })
    }

    fn rule_builtin(&mut self, name: &str, args: &[Value]) -> Value {
        let target = String::from_utf8_lossy(bytes(args, 0)).into_owned();
        let named = self.program.rule_index.get(&target).copied();
        let group = self
            .program
            .groups
            .get(&target)
            .cloned()
            .unwrap_or_default();
        let current = self.current_rule;
        match name {
            "xsEnableRule" | "xsDisableRule" => {
                if let Some(index) = named {
                    self.rules[index].enabled = name == "xsEnableRule";
                }
                Value::Void
            }
            "xsEnableRuleGroup" | "xsDisableRuleGroup" => {
                for index in group {
                    self.rules[index].enabled = name == "xsEnableRuleGroup";
                }
                Value::Void
            }
            "xsIsRuleEnabled" => Value::Bool(named.is_some_and(|index| self.rules[index].enabled)),
            "xsIsRuleGroupEnabled" => Value::Bool(
                !group.is_empty() && group.iter().all(|index| self.rules[*index].enabled),
            ),
            "xsDisableSelf" => {
                if let Some(index) = current {
                    self.rules[index].enabled = false;
                }
                Value::Void
            }
            "xsSetRulePriority" | "xsSetRuleMinInterval" | "xsSetRuleMaxInterval" => {
                if let Some(index) = named {
                    self.set_rule_value(index, name, int(args, 1));
                }
                Value::Void
            }
            "xsSetRulePrioritySelf" | "xsSetRuleMinIntervalSelf" | "xsSetRuleMaxIntervalSelf" => {
                if let Some(index) = current {
                    self.set_rule_value(index, name, int(args, 0));
                }
                Value::Void
            }
            _ => Value::Void,
        }
    }

    fn set_rule_value(&mut self, index: usize, name: &str, value: i32) {
        let rule = &mut self.rules[index];
        if name.contains("Priority") {
            rule.priority = value;
        } else if name.contains("MinInterval") {
            rule.min_interval = value;
        } else {
            rule.max_interval = value;
        }
    }

    fn array_name(&self, kind: ValueKind, id: i32) -> String {
        match self.array(kind, id) {
            Some(array) if !array.name.is_empty() => array.name.clone(),
            _ => id.to_string(),
        }
    }

    pub(crate) fn array(&self, kind: ValueKind, id: i32) -> Option<&ArrayData> {
        usize::try_from(id)
            .ok()
            .and_then(|index| self.arrays.list.get(index))
            .filter(|array| array.kind == kind)
    }

    pub(crate) fn create_array(
        &mut self,
        kind: ValueKind,
        size: i32,
        fill: Value,
        name: String,
        range: ByteRange,
    ) -> Exec<i32> {
        if size < 0 {
            self.topics.insert(Topic::ArrayDefaults);
            return Ok(-1);
        }
        if !name.is_empty() && self.arrays.list.iter().any(|array| array.name == name) {
            self.topics.insert(Topic::ArrayDefaults);
            return Ok(-1);
        }
        if self.arrays.list.len() >= MAXIMUM_ARRAYS {
            return Err(self.stop_memory("arrays", range));
        }
        let size = size as usize;
        if self.arrays.items + size > MAXIMUM_ARRAY_ITEMS {
            return Err(self.stop_memory("arrayItems", range));
        }
        self.charge(size, range)?;
        self.arrays.items += size;
        self.arrays.list.push(ArrayData {
            kind,
            name,
            items: vec![fill; size],
        });
        Ok((self.arrays.list.len() - 1) as i32)
    }

    fn array_builtin(&mut self, name: &str, args: &[Value], range: ByteRange) -> Exec<Value> {
        if name == "xsArrayGetSize" {
            let id = int(args, 0);
            let found = usize::try_from(id)
                .ok()
                .and_then(|index| self.arrays.list.get(index));
            return Ok(Value::Int(match found {
                Some(array) => array.items.len() as i32,
                None => {
                    self.unknown_array_read(id, &Value::Int(-1), range);
                    -1
                }
            }));
        }
        let Some(kind) = array_type(name) else {
            return Err(self.stop_not_run(format!("the call {name}"), range));
        };
        if name.starts_with("xsArrayCreate") {
            let size = int(args, 0);
            let fill = args.get(1).cloned().unwrap_or_else(|| array_default(kind));
            let label = String::from_utf8_lossy(bytes(args, 2)).into_owned();
            let id = self.create_array(kind, size, fill, label, range)?;
            return Ok(Value::Int(id));
        }
        let id = int(args, 0);
        if name.starts_with("xsArrayGet") {
            let index = int(args, 1);
            let default = array_default(kind);
            let Some(array) = self.array(kind, id) else {
                self.unknown_array_read(id, &default, range);
                return Ok(default);
            };
            if let Some(value) = usize::try_from(index)
                .ok()
                .and_then(|index| array.items.get(index))
            {
                return Ok(value.clone());
            }
            let size = array.items.len();
            let label = self.array_name(kind, id);
            let shown = self.shown(&default);
            self.topics.insert(Topic::ArrayDefaults);
            self.finding(
                "XS5003",
                FindingSeverity::Warning,
                format!(
                    "Index {index} is outside array \"{label}\" ({size} items); the run read {shown}"
                ),
                vec![
                    ("access", "read".to_owned()),
                    ("array", label),
                    ("index", index.to_string()),
                    ("size", size.to_string()),
                    ("value", shown),
                ],
                range,
            );
            return Ok(default);
        }
        if name.starts_with("xsArraySet") {
            let index = int(args, 1);
            let value = args.get(2).cloned().unwrap_or_else(|| array_default(kind));
            let size = match self.array(kind, id) {
                Some(array) => array.items.len(),
                None => {
                    self.unknown_array_write(id, range);
                    return Ok(Value::Bool(false));
                }
            };
            match usize::try_from(index).ok().filter(|index| *index < size) {
                Some(index) => {
                    self.arrays.list[id as usize].items[index] = value;
                    Ok(Value::Bool(true))
                }
                None => {
                    let label = self.array_name(kind, id);
                    self.topics.insert(Topic::ArrayDefaults);
                    self.finding(
                        "XS5003",
                        FindingSeverity::Warning,
                        format!(
                            "Index {index} is outside array \"{label}\" ({size} items); the write was skipped"
                        ),
                        vec![
                            ("access", "write".to_owned()),
                            ("array", label),
                            ("index", index.to_string()),
                            ("size", size.to_string()),
                        ],
                        range,
                    );
                    Ok(Value::Bool(false))
                }
            }
        } else {
            let new_size = int(args, 1);
            let Some(array) = self.array(kind, id) else {
                self.unknown_array_write(id, range);
                return Ok(Value::Bool(false));
            };
            if new_size < 0 {
                self.topics.insert(Topic::ArrayDefaults);
                return Ok(Value::Bool(false));
            }
            let old_size = array.items.len();
            let new_size = new_size as usize;
            if new_size > old_size {
                if self.arrays.items + (new_size - old_size) > MAXIMUM_ARRAY_ITEMS {
                    return Err(self.stop_memory("arrayItems", range));
                }
                self.charge(new_size - old_size, range)?;
                self.arrays.items += new_size - old_size;
            } else {
                self.arrays.items -= old_size - new_size;
            }
            let fill = zero_fill(kind);
            self.arrays.list[id as usize].items.resize(new_size, fill);
            Ok(Value::Bool(true))
        }
    }

    fn shown(&self, value: &Value) -> String {
        match value {
            Value::Str(bytes) => format!("\"{}\"", String::from_utf8_lossy(bytes)),
            other => crate::text::number_text(other)
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                .unwrap_or_default(),
        }
    }

    fn unknown_array_read(&mut self, id: i32, default: &Value, range: ByteRange) {
        let shown = self.shown(default);
        self.topics.insert(Topic::ArrayDefaults);
        self.finding(
            "XS5004",
            FindingSeverity::Warning,
            format!("Array {id} does not exist; the run read {shown}"),
            vec![
                ("access", "read".to_owned()),
                ("array", id.to_string()),
                ("value", shown),
            ],
            range,
        );
    }

    pub(crate) fn unknown_array_write(&mut self, id: i32, range: ByteRange) {
        self.topics.insert(Topic::ArrayDefaults);
        self.finding(
            "XS5004",
            FindingSeverity::Warning,
            format!("Array {id} does not exist; the write was skipped"),
            vec![("access", "write".to_owned()), ("array", id.to_string())],
            range,
        );
    }

    fn text_index(&mut self, index: i32, length: usize) -> Option<usize> {
        let length = length as i64;
        let mut index = i64::from(index);
        if index < 0 {
            self.topics.insert(Topic::TextFunctions);
            index += length;
        }
        if index < 0 || index > length {
            self.topics.insert(Topic::TextFunctions);
            return None;
        }
        Some(index as usize)
    }

    fn text_builtin(&mut self, name: &str, args: &[Value], range: ByteRange) -> Exec<Value> {
        let text = bytes(args, 0).to_vec();
        self.charge(text.len(), range)?;
        let result = match name {
            "strLen" => return Ok(Value::Int(text.len() as i32)),
            "strCharAt" => {
                let index = self
                    .text_index(int(args, 1), text.len())
                    .filter(|index| *index < text.len());
                match index {
                    Some(index) => vec![text[index]],
                    None => Vec::new(),
                }
            }
            "strSubstring" => {
                let start = self.text_index(int(args, 1), text.len());
                let end = match int(args, 2) {
                    -1 => Some(text.len()),
                    end => self.text_index(end, text.len()),
                };
                match (start, end) {
                    (Some(start), Some(end)) if start < end => text[start..end].to_vec(),
                    _ => Vec::new(),
                }
            }
            "strContains" => return Ok(Value::Bool(find(&text, bytes(args, 1), 0).is_some())),
            "strStartsWith" => return Ok(Value::Bool(text.starts_with(bytes(args, 1)))),
            "strEndsWith" => return Ok(Value::Bool(text.ends_with(bytes(args, 1)))),
            "strIndexOf" => {
                let from = self.text_index(int(args, 2), text.len());
                let found = from.and_then(|from| find(&text, bytes(args, 1), from));
                return Ok(Value::Int(found.map_or(-1, |index| index as i32)));
            }
            "strLastIndexOf" => {
                let from = match int(args, 2) {
                    -1 => Some(text.len()),
                    from => self.text_index(from, text.len()),
                };
                let found = from.and_then(|from| rfind(&text, bytes(args, 1), from));
                return Ok(Value::Int(found.map_or(-1, |index| index as i32)));
            }
            "strInsert" => {
                let index = self
                    .text_index(int(args, 1), text.len())
                    .unwrap_or(text.len());
                let mut result = text[..index].to_vec();
                result.extend_from_slice(bytes(args, 2));
                result.extend_from_slice(&text[index..]);
                result
            }
            "strRemove" => {
                let start = self.text_index(int(args, 1), text.len());
                match start {
                    Some(start) => {
                        let count = int(args, 2);
                        let end = if count < 0 {
                            text.len()
                        } else {
                            start.saturating_add(count as usize).min(text.len())
                        };
                        let mut result = text[..start].to_vec();
                        result.extend_from_slice(&text[end..]);
                        result
                    }
                    None => text.clone(),
                }
            }
            "strRemovePrefix" => text.strip_prefix(bytes(args, 1)).unwrap_or(&text).to_vec(),
            "strRemoveSuffix" => text.strip_suffix(bytes(args, 1)).unwrap_or(&text).to_vec(),
            "strReplace" => {
                let target = bytes(args, 1);
                let replacement = bytes(args, 2);
                let mut left = int(args, 3);
                if target.is_empty() {
                    self.topics.insert(Topic::TextFunctions);
                    text.clone()
                } else {
                    let mut result = Vec::with_capacity(text.len());
                    let mut position = 0;
                    while left != 0 {
                        let Some(found) = find(&text, target, position) else {
                            break;
                        };
                        result.extend_from_slice(&text[position..found]);
                        result.extend_from_slice(replacement);
                        position = found + target.len();
                        if result.len() > crate::MAXIMUM_TEXT_BYTES {
                            return Err(self.stop_memory("text", range));
                        }
                        left = left.saturating_sub(1).max(-1);
                    }
                    result.extend_from_slice(&text[position..]);
                    result
                }
            }
            "strReverse" => {
                if !text.is_ascii() {
                    self.topics.insert(Topic::TextFunctions);
                }
                text.iter().rev().copied().collect()
            }
            "strToLower" => text.to_ascii_lowercase(),
            "strToUpper" => text.to_ascii_uppercase(),
            "strTrim" | "strTrimStart" | "strTrimEnd" => {
                let mut start = 0;
                let mut end = text.len();
                if name != "strTrimEnd" {
                    while start < end && is_space(text[start]) {
                        start += 1;
                    }
                }
                if name != "strTrimStart" {
                    while end > start && is_space(text[end - 1]) {
                        end -= 1;
                    }
                }
                text[start..end].to_vec()
            }
            "strToInt" => {
                let default = int(args, 2);
                return Ok(Value::Int(match parse_int(&text, int(args, 1) as u32) {
                    Some(value) => value,
                    None => {
                        self.topics.insert(Topic::TextFunctions);
                        default
                    }
                }));
            }
            "strToFloat" => {
                return Ok(Value::Float(match parse_float(&text) {
                    Some(value) => value,
                    None => {
                        self.topics.insert(Topic::TextFunctions);
                        float(args, 1)
                    }
                }));
            }
            "hex" | "bin" => {
                let base = if name == "hex" { 16 } else { 2 };
                return Ok(Value::Int(match parse_bits(&text, base) {
                    Some(value) => value,
                    None => {
                        self.topics.insert(Topic::TextFunctions);
                        int(args, 1)
                    }
                }));
            }
            "ord" => {
                let first = String::from_utf8_lossy(&text).chars().next();
                return Ok(Value::Int(match first {
                    Some(character) if text.len() == character.len_utf8() => character as i32,
                    _ => {
                        self.topics.insert(Topic::TextFunctions);
                        -1
                    }
                }));
            }
            "chr" => match char::from_u32(int(args, 0) as u32) {
                Some(character) => character.to_string().into_bytes(),
                None => {
                    self.topics.insert(Topic::TextFunctions);
                    Vec::new()
                }
            },
            "strSplit" => return self.split(&text, args, range),
            "strJoin" => {
                let id = int(args, 0);
                let delimiter = bytes(args, 1).to_vec();
                let Some(array) = self.array(ValueKind::Str, id) else {
                    self.unknown_array_read(id, &Value::text(""), range);
                    return self.new_text(Vec::new(), range);
                };
                let mut result = Vec::new();
                for (index, item) in array.items.iter().enumerate() {
                    if index > 0 {
                        result.extend_from_slice(&delimiter);
                    }
                    result.extend_from_slice(item.as_bytes().unwrap_or_default());
                    if result.len() > crate::MAXIMUM_TEXT_BYTES {
                        return Err(self.stop_memory("text", range));
                    }
                }
                result
            }
            "fstr" => self.format_names(&text),
            _ => return Err(self.stop_not_run(format!("the call {name}"), range)),
        };
        self.new_text(result, range)
    }

    fn split(&mut self, text: &[u8], args: &[Value], range: ByteRange) -> Exec<Value> {
        let delimiter = bytes(args, 1).to_vec();
        let mut left = int(args, 2);
        let mut parts: Vec<Vec<u8>> = Vec::new();
        if delimiter.is_empty() {
            self.topics.insert(Topic::TextFunctions);
            let mut index = 0;
            while index < text.len() {
                if left == 0 {
                    parts.push(text[index..].to_vec());
                    break;
                }
                parts.push(vec![text[index]]);
                index += 1;
                left = left.saturating_sub(1).max(-1);
            }
            if parts.is_empty() {
                parts.push(Vec::new());
            }
        } else {
            let mut position = 0;
            while left != 0 {
                let Some(found) = find(text, &delimiter, position) else {
                    break;
                };
                parts.push(text[position..found].to_vec());
                position = found + delimiter.len();
                left = left.saturating_sub(1).max(-1);
            }
            parts.push(text[position..].to_vec());
        }
        let count = i32::try_from(parts.len()).unwrap_or(i32::MAX);
        let id = self.create_array(ValueKind::Str, count, Value::text(""), String::new(), range)?;
        for (index, part) in parts.into_iter().enumerate() {
            let value = self.new_text(part, range)?;
            self.arrays.list[id as usize].items[index] = value;
        }
        Ok(Value::Int(id))
    }

    fn format_names(&mut self, text: &[u8]) -> Vec<u8> {
        self.topics.insert(Topic::TextFunctions);
        let mut result = Vec::with_capacity(text.len());
        let mut index = 0;
        while index < text.len() {
            let byte = text[index];
            if (byte == b'{' || byte == b'}') && text.get(index + 1) == Some(&byte) {
                result.push(byte);
                index += 2;
                continue;
            }
            if byte == b'{'
                && let Some(length) = text[index + 1..].iter().position(|byte| *byte == b'}')
            {
                let name = &text[index + 1..index + 1 + length];
                let valid = name
                    .first()
                    .is_some_and(|first| first.is_ascii_alphabetic() || *first == b'_')
                    && name
                        .iter()
                        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'_');
                let value = valid
                    .then(|| std::str::from_utf8(name).ok())
                    .flatten()
                    .and_then(|name| self.variable(name))
                    .and_then(crate::text::number_text);
                if let Some(value) = value {
                    if !matches!(
                        self.variable(std::str::from_utf8(name).unwrap_or("")),
                        Some(Value::Str(_))
                    ) {
                        self.topics.insert(Topic::NumberText);
                    }
                    result.extend_from_slice(&value);
                    index += length + 2;
                    continue;
                }
            }
            result.push(byte);
            index += 1;
        }
        result
    }
}

fn length(v: [f32; 3]) -> f32 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn zero_fill(kind: ValueKind) -> Value {
    crate::value::zero_value(kind).unwrap_or(Value::Void)
}
