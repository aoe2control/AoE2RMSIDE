use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::catalog::{Catalog, Prompt};

pub fn list(catalog: &Catalog) -> Value {
    let prompts: Vec<Value> = catalog
        .prompts
        .iter()
        .map(|prompt| {
            let arguments: Vec<Value> = prompt
                .arguments
                .iter()
                .map(|argument| {
                    json!({
                        "name": argument.name,
                        "description": argument.description,
                        "required": argument.required,
                    })
                })
                .collect();
            json!({
                "name": prompt.name,
                "title": prompt.title,
                "description": prompt.description,
                "arguments": arguments,
            })
        })
        .collect();
    json!({ "prompts": prompts })
}

pub fn get(catalog: &Catalog, params: &Map<String, Value>) -> Result<Value, String> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("name must be a prompt name.")?;
    let prompt = catalog
        .prompt(name)
        .ok_or_else(|| format!("Unknown prompt: {}.", bounded(name)))?;
    let given = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(arguments)) => arguments.clone(),
        Some(_) => return Err("arguments must be an object of texts.".to_owned()),
    };
    let values = resolve(prompt, &given)?;
    Ok(json!({
        "description": prompt.description,
        "messages": [{
            "role": "user",
            "content": { "type": "text", "text": substitute(&prompt.text, &values) },
        }],
    }))
}

fn resolve<'a>(
    prompt: &'a Prompt,
    given: &'a Map<String, Value>,
) -> Result<BTreeMap<&'a str, &'a str>, String> {
    if let Some(unknown) = given.keys().find(|key| {
        !prompt
            .arguments
            .iter()
            .any(|argument| argument.name == **key)
    }) {
        return Err(format!(
            "The prompt {} has no argument {}.",
            prompt.name,
            bounded(unknown)
        ));
    }
    let mut values = BTreeMap::new();
    for argument in &prompt.arguments {
        let value = match given.get(&argument.name) {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) if value.trim().is_empty() => None,
            Some(Value::String(value)) => Some(value.as_str()),
            Some(_) => return Err(format!("{} must be a text.", argument.name)),
        };
        let value = match value {
            Some(value) => {
                if value.chars().count() > argument.max_length {
                    return Err(format!(
                        "{} is longer than {} characters.",
                        argument.name, argument.max_length
                    ));
                }
                if let Some(allowed) = &argument.values
                    && !allowed.iter().any(|allowed| allowed == value)
                {
                    return Err(format!(
                        "{} must be one of: {}.",
                        argument.name,
                        allowed.join(", ")
                    ));
                }
                value
            }
            None if argument.required => return Err(format!("{} is required.", argument.name)),
            None => argument.absent.as_str(),
        };
        values.insert(argument.name.as_str(), value);
    }
    Ok(values)
}

fn substitute(template: &str, values: &BTreeMap<&str, &str>) -> String {
    let mut text = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        text.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after
            .find('}')
            .and_then(|close| values.get(&after[..close]).map(|value| (close, *value)))
        {
            Some((close, value)) => {
                text.push_str(value);
                rest = &after[close + 1..];
            }
            None => {
                text.push('{');
                rest = after;
            }
        }
    }
    text.push_str(rest);
    text
}

fn bounded(text: &str) -> String {
    text.chars().take(64).collect()
}
