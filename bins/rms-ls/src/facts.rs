use std::cell::Cell;
use std::ops::{Deref, DerefMut};

use serde_json::{Value, json};

thread_local! {
    static CLOSED_READ: Cell<bool> = const { Cell::new(false) };
}

pub(crate) const FACTS_CONTRACT: u64 = 1;

pub(crate) fn note_closed_read() {
    CLOSED_READ.with(|flag| flag.set(true));
}

pub(crate) fn reset() {
    CLOSED_READ.with(|flag| flag.set(false));
}

pub(crate) fn closed_read() -> bool {
    CLOSED_READ.with(Cell::get)
}

pub(crate) fn requested(params: &Value) -> bool {
    params
        .get("editorContext")
        .and_then(|context| context.get("factsContract"))
        .and_then(Value::as_u64)
        == Some(FACTS_CONTRACT)
}

pub(crate) fn envelope(result: Value, closed: bool) -> Value {
    json!({
        "rmsEditorFacts": { "contract": FACTS_CONTRACT, "closed": closed },
        "result": result,
    })
}

pub(crate) fn envelope_text(result: &str, closed: bool) -> String {
    format!(
        "{{\"rmsEditorFacts\":{{\"contract\":{FACTS_CONTRACT},\"closed\":{closed}}},\"result\":{result}}}"
    )
}

#[derive(Clone, Default)]
pub(crate) struct Closed<T>(T);

impl<T> Closed<T> {
    pub(crate) fn peek(&self) -> &T {
        &self.0
    }
}

impl<T> Deref for Closed<T> {
    type Target = T;

    fn deref(&self) -> &T {
        note_closed_read();
        &self.0
    }
}

impl<T> DerefMut for Closed<T> {
    fn deref_mut(&mut self) -> &mut T {
        note_closed_read();
        &mut self.0
    }
}
