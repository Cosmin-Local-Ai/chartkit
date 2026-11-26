//! Serves the built web client. Files are read from disk per request so a rebuilt
//! UI needs no restart, and path traversal is refused.

use axum::extract::State;
use axum::http::{StatusCode, Uri};
use axum::response::{IntoResponse, Response};

use crate::state::AppState;

const TYPES: &[(&str, &str)] = &[
    ("html", "text/html; charset=utf-8"),
    ("js", "text/javascript; charset=utf-8"),
    ("mjs", "text/javascript; charset=utf-8"),
    ("css", "text/css; charset=utf-8"),
    ("json", "application/json"),
    ("svg", "image/svg+xml"),
    ("png", "image/png"),
    ("ico", "image/x-icon"),
    ("woff2", "font/woff2"),
    ("map", "application/json"),
    ("webmanifest", "application/manifest+json"),
];

pub async fn serve(State(state): State<AppState>, uri: Uri) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") {
        return (StatusCode::NOT_FOUND, "no such endpoint").into_response();
    }
    let relative = path.trim_start_matches('/');
    let Some(resolved) = resolve(&state.ui_dir, relative) else {
        return (StatusCode::BAD_REQUEST, "bad path").into_response();
    };
    let candidate = if relative.is_empty() { resolved.join("index.html") } else { resolved.clone() };
    if candidate.is_file() {
        return file_response(&candidate);
    }
    // Single page app: unknown routes fall through to the shell.
    let shell = state.ui_dir.join("index.html");
    if shell.is_file() {
        return file_response(&shell);
    }
    (
        StatusCode::NOT_FOUND,
        "web client not built: run `npm run build` in ui/, or point --ui-dir at it",
    )
        .into_response()
}

fn resolve(root: &std::path::Path, relative: &str) -> Option<std::path::PathBuf> {
    let mut out = root.to_path_buf();
    for part in relative.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        out.push(part);
    }
    Some(out)
}

fn file_response(path: &std::path::Path) -> Response {
    let Ok(bytes) = std::fs::read(path) else {
        return (StatusCode::NOT_FOUND, "not found").into_response();
    };
    let extension = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let content_type = TYPES
        .iter()
        .find(|(ext, _)| *ext == extension)
        .map(|(_, mime)| *mime)
        .unwrap_or("application/octet-stream");
    ([(axum::http::header::CONTENT_TYPE, content_type)], bytes).into_response()
}
