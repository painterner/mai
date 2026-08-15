use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap},
};
use unicode_width::UnicodeWidthStr;

use crate::app::{App, Role};
use crate::markdown;

/// Main draw function
pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();

    // Layout: [header] [messages] [status] [input]
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // header
            Constraint::Min(5),    // messages
            Constraint::Length(1), // status bar
            Constraint::Length(3), // input
        ])
        .split(area);

    draw_header(frame, app, chunks[0]);
    draw_messages(frame, app, chunks[1]);
    draw_status(frame, app, chunks[2]);
    draw_input(frame, app, chunks[3]);
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let title = format!(
        " ✨ Gemini CLI v{} │ {} │ {} │ {} ",
        env!("CARGO_PKG_VERSION"),
        app.config.provider,
        app.model,
        app.mode
    );

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan));

    frame.render_widget(block, area);
}

fn draw_messages(frame: &mut Frame, app: &App, area: Rect) {
    let block = Block::default()
        .borders(Borders::LEFT | Borders::RIGHT)
        .border_style(Style::default().fg(Color::DarkGray));

    let inner_area = block.inner(area);
    frame.render_widget(block, area);

    if app.messages.is_empty() {
        let welcome = Paragraph::new(Text::from(vec![
            Line::from(""),
            Line::from(Span::styled(
                "  Welcome to Gemini CLI! 🚀",
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
            Line::from(Span::styled(
                "  Type your message and press Enter to chat.",
                Style::default().fg(Color::Gray),
            )),
            Line::from(Span::styled(
                "  Type /help for available commands.",
                Style::default().fg(Color::Gray),
            )),
        ]));
        frame.render_widget(welcome, inner_area);
        return;
    }

    // Render messages
    let mut lines: Vec<Line> = Vec::new();
    let content_width = inner_area.width.saturating_sub(2) as usize;

    for msg in &app.messages {
        lines.push(Line::from("")); // spacing

        match msg.role {
            Role::User => {
                lines.push(Line::from(Span::styled(
                    " 👤 You:",
                    Style::default()
                        .fg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                )));
                for line in msg.content.lines() {
                    lines.push(Line::from(Span::styled(
                        format!("   {line}"),
                        Style::default().fg(Color::White),
                    )));
                }
            }
            Role::Assistant => {
                let prefix = if msg.is_streaming {
                    " ✨ Assistant: ▍"
                } else {
                    " ✨ Assistant:"
                };
                lines.push(Line::from(Span::styled(
                    prefix,
                    Style::default()
                        .fg(Color::Cyan)
                        .add_modifier(Modifier::BOLD),
                )));
                // Render markdown content
                let rendered = markdown::render_to_lines(&msg.content, content_width);
                for line in rendered {
                    lines.push(line);
                }
            }
            Role::System => {
                lines.push(Line::from(Span::styled(
                    format!(" ℹ️  {}", msg.content.lines().next().unwrap_or("")),
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::ITALIC),
                )));
                for line in msg.content.lines().skip(1) {
                    lines.push(Line::from(Span::styled(
                        format!("    {line}"),
                        Style::default().fg(Color::Yellow),
                    )));
                }
            }
            Role::Tool => {
                lines.push(Line::from(Span::styled(
                    format!(" 🔧 Tool: {}", msg.content.lines().next().unwrap_or("")),
                    Style::default()
                        .fg(Color::Magenta)
                        .add_modifier(Modifier::BOLD),
                )));
                for line in msg.content.lines().skip(1) {
                    lines.push(Line::from(Span::styled(
                        format!("    {line}"),
                        Style::default().fg(Color::DarkGray),
                    )));
                }
            }
        }
    }

    let total_lines = lines.len() as u16;
    let visible_height = inner_area.height;
    let max_scroll = total_lines.saturating_sub(visible_height);
    let scroll = max_scroll.saturating_sub(app.scroll_offset);

    let paragraph = Paragraph::new(Text::from(lines))
        .scroll((scroll, 0))
        .wrap(Wrap { trim: false });

    frame.render_widget(paragraph, inner_area);

    // Scrollbar
    if total_lines > visible_height {
        let mut scrollbar_state =
            ScrollbarState::new(max_scroll as usize).position(scroll as usize);
        frame.render_stateful_widget(
            Scrollbar::new(ScrollbarOrientation::VerticalRight),
            area,
            &mut scrollbar_state,
        );
    }
}

fn draw_status(frame: &mut Frame, app: &App, area: Rect) {
    let status_text = if app.waiting {
        Span::styled(
            format!(" ⏳ {} ", app.status),
            Style::default().fg(Color::Yellow),
        )
    } else if !app.status.is_empty() {
        Span::styled(
            format!(" {} ", app.status),
            Style::default().fg(Color::DarkGray),
        )
    } else {
        Span::styled(
            " Ready │ Ctrl+C: cancel/quit │ /help: commands ",
            Style::default().fg(Color::DarkGray),
        )
    };

    let paragraph = Paragraph::new(Line::from(status_text));
    frame.render_widget(paragraph, area);
}

fn draw_input(frame: &mut Frame, app: &App, area: Rect) {
    let prompt_style = if app.waiting {
        Style::default().fg(Color::DarkGray)
    } else {
        Style::default().fg(Color::Cyan)
    };

    let input_block = Block::default()
        .title(" > Input ")
        .title_style(prompt_style)
        .borders(Borders::ALL)
        .border_style(prompt_style);

    let inner = input_block.inner(area);
    frame.render_widget(input_block, area);

    let display_text = if app.input.is_empty() && !app.waiting {
        Span::styled("Type your message...", Style::default().fg(Color::DarkGray))
    } else {
        Span::styled(&app.input, Style::default().fg(Color::White))
    };

    let input_paragraph = Paragraph::new(Line::from(display_text));
    frame.render_widget(input_paragraph, inner);

    // Set cursor position
    if !app.waiting {
        let cursor_x = inner.x + app.input[..app.cursor_pos].width() as u16;
        let cursor_y = inner.y;
        frame.set_cursor_position((cursor_x, cursor_y));
    }
}
