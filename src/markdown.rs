use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};

/// Simple markdown renderer for terminal display.
/// Converts markdown text to styled ratatui Lines.
pub fn render_to_lines(text: &str, _width: usize) -> Vec<Line<'static>> {
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut in_code_block = false;
    let mut code_lang = String::new();

    for line in text.lines() {
        // Code block toggle
        if line.trim_start().starts_with("```") {
            if in_code_block {
                // End code block
                in_code_block = false;
                lines.push(Line::from(Span::styled(
                    "   └─────────────────────────────",
                    Style::default().fg(Color::DarkGray),
                )));
                code_lang.clear();
            } else {
                // Start code block
                in_code_block = true;
                code_lang = line.trim_start().trim_start_matches('`').to_string();
                let label = if code_lang.is_empty() {
                    "   ┌─ code ─────────────────────".to_string()
                } else {
                    format!("   ┌─ {code_lang} ─────────────────────")
                };
                lines.push(Line::from(Span::styled(
                    label,
                    Style::default().fg(Color::DarkGray),
                )));
            }
            continue;
        }

        if in_code_block {
            lines.push(Line::from(Span::styled(
                format!("   │ {line}"),
                Style::default().fg(Color::Green),
            )));
            continue;
        }

        // Headers
        if let Some(heading) = line.strip_prefix("### ") {
            lines.push(Line::from(Span::styled(
                format!("   {heading}"),
                Style::default()
                    .fg(Color::Magenta)
                    .add_modifier(Modifier::BOLD),
            )));
            continue;
        }
        if let Some(heading) = line.strip_prefix("## ") {
            lines.push(Line::from(Span::styled(
                format!("   {heading}"),
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )));
            continue;
        }
        if let Some(heading) = line.strip_prefix("# ") {
            lines.push(Line::from(Span::styled(
                format!("   {heading}"),
                Style::default()
                    .fg(Color::Yellow)
                    .add_modifier(Modifier::BOLD | Modifier::UNDERLINED),
            )));
            continue;
        }

        // Bullet list
        let trimmed = line.trim_start();
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") {
            let indent = line.len() - trimmed.len();
            let prefix = " ".repeat(indent + 3);
            lines.push(Line::from(vec![
                Span::styled(format!("{prefix}• "), Style::default().fg(Color::Cyan)),
                Span::styled(trimmed[2..].to_string(), Style::default().fg(Color::White)),
            ]));
            continue;
        }

        // Numbered list
        if let Some(rest) = try_parse_numbered(trimmed) {
            lines.push(Line::from(Span::styled(
                format!("   {rest}"),
                Style::default().fg(Color::White),
            )));
            continue;
        }

        // Bold text (simple inline)
        let rendered = render_inline(line);
        lines.push(Line::from(
            rendered
                .into_iter()
                .map(|(text, style)| Span::styled(format!("   {text}"), style))
                .collect::<Vec<_>>(),
        ));
    }

    lines
}

/// Try to parse a numbered list item (e.g., "1. text")
fn try_parse_numbered(line: &str) -> Option<String> {
    let mut chars = line.chars();
    let first = chars.next()?;
    if !first.is_ascii_digit() {
        return None;
    }
    // consume remaining digits
    let rest: String = chars.collect();
    let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit());
    if rest.starts_with(". ") {
        Some(line.to_string())
    } else {
        None
    }
}

/// Simple inline markdown rendering (bold, italic, code)
fn render_inline(text: &str) -> Vec<(String, Style)> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        // Inline code: `text`
        if chars[i] == '`' {
            if !current.is_empty() {
                segments.push((current.clone(), Style::default().fg(Color::White)));
                current.clear();
            }
            i += 1;
            let mut code = String::new();
            while i < len && chars[i] != '`' {
                code.push(chars[i]);
                i += 1;
            }
            if i < len {
                i += 1; // skip closing `
            }
            segments.push((code, Style::default().fg(Color::Green)));
            continue;
        }

        // Bold: **text**
        if i + 1 < len && chars[i] == '*' && chars[i + 1] == '*' {
            if !current.is_empty() {
                segments.push((current.clone(), Style::default().fg(Color::White)));
                current.clear();
            }
            i += 2;
            let mut bold = String::new();
            while i + 1 < len && !(chars[i] == '*' && chars[i + 1] == '*') {
                bold.push(chars[i]);
                i += 1;
            }
            if i + 1 < len {
                i += 2; // skip closing **
            }
            segments.push((
                bold,
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::BOLD),
            ));
            continue;
        }

        // Italic: *text*
        if chars[i] == '*' {
            if !current.is_empty() {
                segments.push((current.clone(), Style::default().fg(Color::White)));
                current.clear();
            }
            i += 1;
            let mut italic = String::new();
            while i < len && chars[i] != '*' {
                italic.push(chars[i]);
                i += 1;
            }
            if i < len {
                i += 1; // skip closing *
            }
            segments.push((
                italic,
                Style::default()
                    .fg(Color::White)
                    .add_modifier(Modifier::ITALIC),
            ));
            continue;
        }

        current.push(chars[i]);
        i += 1;
    }

    if !current.is_empty() {
        segments.push((current, Style::default().fg(Color::White)));
    }

    if segments.is_empty() {
        segments.push((String::new(), Style::default()));
    }

    segments
}
