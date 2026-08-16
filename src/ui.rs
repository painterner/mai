use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, Borders, Paragraph, Scrollbar, ScrollbarOrientation, ScrollbarState, Wrap},
};
use unicode_width::UnicodeWidthStr;

use crate::agent::ApprovalMode;
use crate::app::{App, ChatMode, Role};
use crate::markdown;

const CHAT_WIDTH: u16 = 6;
const AGENT_WIDTH: u16 = 7;
const MODE_GAP_WIDTH: u16 = 1;
const AUTO_WIDTH: u16 = 6;
const MANUAL_WIDTH: u16 = 8;
const MODE_CONTROLS_WIDTH: u16 =
    CHAT_WIDTH + AGENT_WIDTH + MODE_GAP_WIDTH + AUTO_WIDTH + MANUAL_WIDTH;
const APPROVE_WIDTH: u16 = 9;
const REJECT_WIDTH: u16 = 8;
const APPROVAL_CONTROLS_WIDTH: u16 = APPROVE_WIDTH + REJECT_WIDTH;
const MIN_CONTROL_AREA_WIDTH: u16 = 42;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputControl {
    Chat,
    Agent,
    Auto,
    Manual,
    Approve,
    Reject,
}

/// Main draw function
pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    let regions = main_regions(area);

    draw_header(frame, app, regions[0]);
    draw_messages(frame, app, regions[1]);
    draw_status(frame, app, regions[2]);
    draw_input(frame, app, regions[3]);
}

fn main_regions(area: Rect) -> [Rect; 4] {
    let regions = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(1),
            Constraint::Length(3),
        ])
        .split(area);
    [regions[0], regions[1], regions[2], regions[3]]
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let title = format!(
        " ✨ {} v{} │ {} │ {} ",
        crate::APP_NAME,
        env!("CARGO_PKG_VERSION"),
        app.config.provider,
        app.model
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
                format!("  Welcome to {}! 🚀", crate::APP_NAME),
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

    let mut input_block = Block::default()
        .title(Line::from(" > Input ").left_aligned())
        .title_style(prompt_style)
        .borders(Borders::ALL)
        .border_style(prompt_style);
    if let Some(title) = input_controls_title(app, area) {
        input_block = input_block.title(title);
    }

    let inner = input_block.inner(area);
    frame.render_widget(input_block, area);

    let display_text = if let Some(pending) = &app.pending_approval {
        Span::styled(
            approval_summary(&pending.tool, &pending.arguments, inner.width as usize),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )
    } else if app.input.is_empty() && !app.waiting {
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

fn input_controls_title<'a>(app: &App, area: Rect) -> Option<Line<'a>> {
    if area.width < MIN_CONTROL_AREA_WIDTH {
        return None;
    }

    if app.pending_approval.is_some() {
        return Some(
            Line::from(vec![
                Span::styled(
                    " Approve ",
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Green)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    " Reject ",
                    Style::default()
                        .fg(Color::Black)
                        .bg(Color::Red)
                        .add_modifier(Modifier::BOLD),
                ),
            ])
            .right_aligned(),
        );
    }

    let enabled = !app.waiting;
    Some(
        Line::from(vec![
            Span::styled(
                " Chat ",
                segmented_style(app.mode == ChatMode::Chat, Color::Cyan, enabled),
            ),
            Span::styled(
                " Agent ",
                segmented_style(app.mode == ChatMode::Agent, Color::Magenta, enabled),
            ),
            Span::raw(" "),
            Span::styled(
                " Auto ",
                segmented_style(
                    app.approval_mode == ApprovalMode::Auto,
                    Color::Green,
                    enabled,
                ),
            ),
            Span::styled(
                " Manual ",
                segmented_style(
                    app.approval_mode == ApprovalMode::Manual,
                    Color::Yellow,
                    enabled,
                ),
            ),
        ])
        .right_aligned(),
    )
}

fn segmented_style(selected: bool, color: Color, enabled: bool) -> Style {
    if !enabled {
        Style::default().fg(Color::DarkGray)
    } else if selected {
        Style::default()
            .fg(Color::Black)
            .bg(color)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(color)
    }
}

fn approval_summary(tool: &str, arguments: &str, width: usize) -> String {
    let summary = format!("Pending {tool}: {}", arguments.replace('\n', " "));
    if summary.width() <= width {
        return summary;
    }
    let take = width.saturating_sub(3);
    format!("{}...", summary.chars().take(take).collect::<String>())
}

pub fn input_control_at(
    frame_area: Rect,
    column: u16,
    row: u16,
    approval_pending: bool,
) -> Option<InputControl> {
    let input_area = main_regions(frame_area)[3];
    if input_area.width < MIN_CONTROL_AREA_WIDTH || row != input_area.y {
        return None;
    }

    let right = input_area.right().saturating_sub(1);
    let controls = if approval_pending {
        approval_control_areas(right, input_area.y)
    } else {
        mode_control_areas(right, input_area.y)
    };
    controls
        .into_iter()
        .find_map(|(control, area)| contains(area, column, row).then_some(control))
}

fn mode_control_areas(right: u16, row: u16) -> Vec<(InputControl, Rect)> {
    let start = right.saturating_sub(MODE_CONTROLS_WIDTH);
    vec![
        (InputControl::Chat, Rect::new(start, row, CHAT_WIDTH, 1)),
        (
            InputControl::Agent,
            Rect::new(start + CHAT_WIDTH, row, AGENT_WIDTH, 1),
        ),
        (
            InputControl::Auto,
            Rect::new(
                start + CHAT_WIDTH + AGENT_WIDTH + MODE_GAP_WIDTH,
                row,
                AUTO_WIDTH,
                1,
            ),
        ),
        (
            InputControl::Manual,
            Rect::new(right - MANUAL_WIDTH, row, MANUAL_WIDTH, 1),
        ),
    ]
}

fn approval_control_areas(right: u16, row: u16) -> Vec<(InputControl, Rect)> {
    let start = right.saturating_sub(APPROVAL_CONTROLS_WIDTH);
    vec![
        (
            InputControl::Approve,
            Rect::new(start, row, APPROVE_WIDTH, 1),
        ),
        (
            InputControl::Reject,
            Rect::new(start + APPROVE_WIDTH, row, REJECT_WIDTH, 1),
        ),
    ]
}

fn contains(area: Rect, column: u16, row: u16) -> bool {
    column >= area.x && column < area.right() && row >= area.y && row < area.bottom()
}

#[cfg(test)]
mod tests {
    use ratatui::{Terminal, backend::TestBackend};

    use super::*;
    use crate::app::PendingApproval;
    use crate::cli::Args;
    use crate::config::Config;

    fn test_app() -> App {
        App::new(
            Config::default(),
            Args {
                prompt: None,
                model: None,
                provider: None,
                agent: false,
                agent_max_steps: 12,
                allow_shell: false,
                debug: false,
            },
        )
        .unwrap()
    }

    fn render_text(app: &App) -> String {
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        terminal
            .backend()
            .buffer()
            .content()
            .iter()
            .fold(String::new(), |mut output, cell| {
                output.push_str(cell.symbol());
                output
            })
    }

    #[test]
    fn mode_controls_match_right_aligned_title_positions() {
        let frame = Rect::new(0, 0, 100, 30);
        let input = main_regions(frame)[3];
        let right = input.right() - 1;
        let areas = mode_control_areas(right, input.y);

        for (control, area) in areas {
            assert_eq!(
                input_control_at(frame, area.x, area.y, false),
                Some(control)
            );
        }
        assert_eq!(input_control_at(frame, right, input.y, false), None);
    }

    #[test]
    fn pending_approval_replaces_mode_hit_targets() {
        let frame = Rect::new(0, 0, 100, 30);
        let input = main_regions(frame)[3];
        let right = input.right() - 1;
        let areas = approval_control_areas(right, input.y);

        assert_eq!(
            input_control_at(frame, areas[0].1.x, input.y, true),
            Some(InputControl::Approve)
        );
        assert_eq!(
            input_control_at(frame, areas[1].1.x, input.y, true),
            Some(InputControl::Reject)
        );
    }

    #[test]
    fn controls_are_hidden_in_narrow_terminal() {
        assert_eq!(
            input_control_at(Rect::new(0, 0, 30, 20), 20, 17, false),
            None
        );
    }

    #[test]
    fn renders_mode_controls_in_input_border() {
        let rendered = render_text(&test_app());
        assert!(rendered.contains(crate::APP_NAME));
        assert!(rendered.contains(" Chat "));
        assert!(rendered.contains(" Agent "));
        assert!(rendered.contains(" Auto "));
        assert!(rendered.contains(" Manual "));
    }

    #[test]
    fn renders_approval_controls_for_pending_tool() {
        let mut app = test_app();
        app.pending_approval = Some(PendingApproval {
            tool: "write_file".to_string(),
            arguments: r#"{"path":"README.md"}"#.to_string(),
        });

        let rendered = render_text(&app);
        assert!(rendered.contains(" Approve "));
        assert!(rendered.contains(" Reject "));
        assert!(rendered.contains("Pending write_file"));
    }
}
