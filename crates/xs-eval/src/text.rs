use crate::value::Value;

pub fn float_text(value: f32) -> String {
    if value.is_nan() {
        return "nan".to_owned();
    }
    if value.is_infinite() {
        return if value > 0.0 { "inf" } else { "-inf" }.to_owned();
    }
    let mut text = format!("{value:.5}");
    while text.ends_with('0') && !text.ends_with(".0") {
        text.pop();
    }
    text
}

pub fn number_text(value: &Value) -> Option<Vec<u8>> {
    Some(match value {
        Value::Int(value) => value.to_string().into_bytes(),
        Value::Float(value) => float_text(*value).into_bytes(),
        Value::Bool(value) => {
            if *value {
                b"1".to_vec()
            } else {
                b"0".to_vec()
            }
        }
        Value::Str(bytes) => bytes.to_vec(),
        Value::Vector([x, y, z]) => format!(
            "({}, {}, {})",
            float_text(*x),
            float_text(*y),
            float_text(*z)
        )
        .into_bytes(),
        Value::Object(_) | Value::Void => return None,
    })
}
