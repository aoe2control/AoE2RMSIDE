use crate::quality::{
    MAX_QUALITY_TEXT_LINES, MAX_QUALITY_TEXT_LINES_PER_ITEM, QualityBlock, QualityItem,
    QualityLevel, QualityResult, QualitySkipReason,
};

fn plural(count: u32, one: &str, many: &str) -> String {
    if count == 1 {
        format!("1 {one}")
    } else {
        format!("{count} {many}")
    }
}

fn unit_for(value: i64, unit: &str) -> &str {
    if value.abs() != 1 {
        return unit;
    }
    let stem = unit.strip_suffix("es").filter(|stem| {
        ["sh", "ch", "x", "ss"]
            .iter()
            .any(|ending| stem.ends_with(ending))
    });
    stem.or_else(|| unit.strip_suffix('s')).unwrap_or(unit)
}

fn header(block: &QualityBlock) -> String {
    let mut line = format!(
        "Quality check of {}",
        plural(block.samples, "sample", "samples")
    );
    if block.failed_samples > 0 {
        line.push_str(&format!(" ({} did not generate)", block.failed_samples));
    }
    let last = block
        .seed_start
        .wrapping_add(block.seed_count.saturating_sub(1));
    if block.seed_count == 1 {
        line.push_str(&format!(", seed {}", block.seed_start));
    } else {
        line.push_str(&format!(", seeds {} to {last}", block.seed_start));
    }
    let counts = block.counts;
    let mut parts = Vec::new();
    if counts.failures > 0 {
        parts.push(plural(counts.failures, "failure", "failures"));
    }
    if counts.warnings > 0 {
        parts.push(plural(counts.warnings, "warning", "warnings"));
    }
    if counts.advice > 0 {
        parts.push(plural(counts.advice, "note", "notes"));
    }
    if block.result == QualityResult::Passed && parts.is_empty() {
        line.push_str(": passed");
    } else {
        line.push_str(": ");
        line.push_str(&parts.join(", "));
    }
    line
}

fn item_lines(item: &QualityItem) -> Vec<String> {
    let tag = match item.level {
        QualityLevel::Failure => "FAIL",
        QualityLevel::Warning => "WARN",
        QualityLevel::Advice => "NOTE",
    };
    let mut lines = vec![format!(
        "{tag} {}: {} ({} of {})",
        item.case,
        item.message,
        item.bad,
        plural(item.of, "sample", "samples")
    )];
    let mut detail = Vec::new();
    if let Some(metric) = &item.metric {
        detail.push(format!(
            "{}: p50 {}, p95 {}, max {} {}.",
            metric.label,
            metric.p50,
            metric.p95,
            metric.max,
            unit_for(metric.max, &metric.unit)
        ));
    }
    if !item.worst.is_empty() {
        let worst = item
            .worst
            .iter()
            .map(|worst| match worst.settings_index {
                Some(index) => format!("seed {} (setting {})", worst.seed, index + 1),
                None => format!("seed {}", worst.seed),
            })
            .collect::<Vec<_>>()
            .join(", ");
        detail.push(format!("Worst: {worst}"));
    }
    if !detail.is_empty() {
        lines.push(format!("  {}", detail.join(" ")));
    }
    lines.truncate(MAX_QUALITY_TEXT_LINES_PER_ITEM);
    lines
}

fn footer(block: &QualityBlock) -> Vec<String> {
    let mut lines = Vec::new();
    if !block.passed.is_empty() {
        lines.push(format!("Passed: {}", block.passed.join(", ")));
    }
    for (reason, label) in [
        (QualitySkipReason::NotApplicable, "Not applicable"),
        (QualitySkipReason::NoSamples, "No map to measure"),
    ] {
        let cases = block
            .skipped
            .iter()
            .filter(|skip| skip.reason == reason)
            .map(|skip| skip.case.as_str())
            .collect::<Vec<_>>();
        if !cases.is_empty() {
            lines.push(format!("{label}: {}", cases.join(", ")));
        }
    }
    lines
}

pub fn render_quality_text(block: &QualityBlock) -> Vec<String> {
    let footer = footer(block);
    let mut lines = vec![header(block)];
    let rendered = block.items.iter().map(item_lines).collect::<Vec<_>>();
    let total = rendered.iter().map(Vec::len).sum::<usize>();
    let shown = if 1 + total + footer.len() <= MAX_QUALITY_TEXT_LINES && block.omitted_items == 0 {
        rendered.len()
    } else {
        let room = MAX_QUALITY_TEXT_LINES.saturating_sub(2 + footer.len());
        let mut used = 0;
        rendered
            .iter()
            .take_while(|item| {
                used += item.len();
                used <= room
            })
            .count()
    };
    for item in rendered.iter().take(shown) {
        lines.extend(item.iter().cloned());
    }
    let left_out = (block.items.len() - shown) as u32 + block.omitted_items;
    if left_out > 0 {
        let noun = if left_out == 1 { "item" } else { "items" };
        lines.push(format!("...and {left_out} more {noun}"));
    }
    lines.extend(footer);
    lines.truncate(MAX_QUALITY_TEXT_LINES);
    lines
}
