// ratatui view layer — the only all-new code in this crate (plan section 3).

pub mod dashboard;
pub mod settings_view;
pub mod skills_view;

use crate::app::{App, View};
use ratatui::style::Style;
use ratatui::widgets::Block;
use ratatui::Frame;

pub fn draw(f: &mut Frame, app: &mut App) {
    // Window background (SPEC 11.1 WindowBgBrush)
    let p = app.palette();
    f.render_widget(Block::default().style(Style::default().bg(p.window_bg)), f.area());
    match app.view {
        View::Dashboard => dashboard::draw(f, app, &p),
        View::Settings => settings_view::draw(f, app, &p),
        View::Skills => skills_view::draw(f, app, &p),
    }
}
