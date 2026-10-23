//! Bounded table search on an isolated connection. The grid connection is never interrupted.
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use duckdb::{params, Connection, InterruptHandle};
use parking_lot::{Condvar, Mutex};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{State, Window};

const RESULT_LIMIT: usize = 100;
const PREVIEW_CHARS: usize = 320;
const MAX_COLUMNS: usize = 200;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSearchRequest {
    pub request_id: u64,
    pub table_name: String,
    pub columns: Vec<String>,
    pub term: String,
    pub filter_sql: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub column: String,
    pub preview: String,
    pub truncated_start: bool,
    pub truncated_end: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSearchResult {
    pub status: &'static str,
    pub matches: Vec<SearchMatch>,
    pub has_more: bool,
    pub limit: usize,
}

impl TableSearchResult {
    fn stopped(status: &'static str) -> Self {
        Self { status, matches: Vec::new(), has_more: false, limit: RESULT_LIMIT }
    }
}

#[derive(Default)]
struct JobControl {
    interrupt: Option<Arc<InterruptHandle>>,
    cancelled: bool,
    timed_out: bool,
    complete: bool,
}

struct SearchJob {
    control: Mutex<JobControl>,
    changed: Condvar,
    deadline: Instant,
}

impl SearchJob {
    fn new(timeout: Duration) -> Arc<Self> {
        Arc::new(Self { control: Mutex::new(JobControl::default()), changed: Condvar::new(), deadline: Instant::now() + timeout })
    }

    fn cancel(&self) {
        let mut control = self.control.lock();
        if !control.complete { control.cancelled = true; }
        self.changed.notify_all();
    }

    fn stopped(&self) -> Option<&'static str> {
        let control = self.control.lock();
        if control.timed_out { Some("timedOut") } else if control.cancelled { Some("cancelled") } else { None }
    }

    fn attach(&self, connection: &Connection) {
        self.control.lock().interrupt = Some(connection.interrupt_handle());
        self.changed.notify_all();
    }

    fn finish(&self) -> Option<&'static str> {
        let mut control = self.control.lock();
        control.complete = true;
        control.interrupt = None;
        self.changed.notify_all();
        if control.timed_out { Some("timedOut") } else if control.cancelled { Some("cancelled") } else { None }
    }

    fn monitor(self: &Arc<Self>) {
        let job = self.clone();
        std::thread::spawn(move || {
            let mut control = job.control.lock();
            while !control.complete {
                let now = Instant::now();
                if now >= job.deadline && !control.cancelled { control.timed_out = true; }
                if control.cancelled || control.timed_out {
                    // An interrupt is not sticky before prepare/query starts. Repeat until completion
                    // so cancellation in that gap (or before the worker starts) cannot be lost.
                    if let Some(interrupt) = &control.interrupt { interrupt.interrupt(); }
                    job.changed.wait_for(&mut control, Duration::from_millis(10));
                } else {
                    job.changed.wait_for(&mut control, job.deadline.saturating_duration_since(now));
                }
            }
        });
    }
}

#[derive(Default)]
struct WindowSearch {
    latest_request: u64,
    job: Option<Arc<SearchJob>>,
}

#[derive(Default)]
pub struct TableSearchState {
    windows: Mutex<HashMap<String, WindowSearch>>,
}

impl TableSearchState {
    fn reserve(&self, label: &str, request_id: u64, timeout: Duration) -> Result<Arc<SearchJob>, &'static str> {
        let mut windows = self.windows.lock();
        let slot = windows.entry(label.to_string()).or_default();
        if request_id <= slot.latest_request { return Err("cancelled"); }
        slot.latest_request = request_id;
        if let Some(job) = &slot.job {
            job.cancel();
            return Err("busy");
        }
        let job = SearchJob::new(timeout);
        slot.job = Some(job.clone());
        Ok(job)
    }

    fn release(&self, label: &str, job: &Arc<SearchJob>) {
        if let Some(slot) = self.windows.lock().get_mut(label) {
            if slot.job.as_ref().is_some_and(|active| Arc::ptr_eq(active, job)) { slot.job = None; }
        }
    }

    fn cancel(&self, label: &str, request_id: u64) {
        let mut windows = self.windows.lock();
        let slot = windows.entry(label.to_string()).or_default();
        // A late cancellation for an older search must not stop its replacement.
        if request_id < slot.latest_request { return; }
        slot.latest_request = request_id;
        if let Some(job) = &slot.job { job.cancel(); }
    }

    pub fn close_for(&self, label: &str) {
        if let Some(slot) = self.windows.lock().remove(label) {
            if let Some(job) = slot.job { job.cancel(); }
        }
    }
}

fn identifier(value: &str) -> String { format!("\"{}\"", value.replace('"', "\"\"")) }
fn literal(value: &str) -> String { format!("'{}'", value.replace('\'', "''")) }

fn validate_request(request: &TableSearchRequest) -> AppResult<()> {
    if request.request_id == 0 || request.request_id > 9_007_199_254_740_991 { return Err(AppError::msg("Invalid search request.")); }
    if request.term.is_empty() || request.term.chars().count() > 2048 { return Err(AppError::msg("Enter between 1 and 2,048 characters to search.")); }
    if request.columns.is_empty() { return Err(AppError::msg("Show a column before searching.")); }
    if request.columns.len() > MAX_COLUMNS { return Err(AppError::msg("Choose a specific column when searching more than 200 visible columns.")); }
    if request.table_name.len() > 4096 || request.columns.iter().any(|column| column.len() > 4096) || request.filter_sql.len() > 262_144 {
        return Err(AppError::msg("This search scope is too large. Choose a column or simplify the filters."));
    }
    Ok(())
}

fn search_sql(request: &TableSearchRequest) -> String {
    let mut predicates = Vec::new();
    let mut cases = Vec::new();
    for column in &request.columns {
        let text = format!("CAST({} AS VARCHAR)", identifier(column));
        let position = format!("strpos(lower({text}), lower($1))");
        let predicate = format!("contains(lower({text}), lower($1))");
        let start = format!("greatest(1, {position} - 80)");
        cases.push(format!("WHEN {predicate} THEN struct_pack(\"column\" := {}, preview := substring({text}, {start}, {PREVIEW_CHARS}), truncatedStart := {position} > 81, truncatedEnd := length({text}) >= {start} + {PREVIEW_CHARS})", literal(column)));
        predicates.push(predicate);
    }
    let scope = if request.filter_sql.is_empty() { String::new() } else { format!("({}) AND ", request.filter_sql) };
    // LIMIT is enforced natively, independent of renderer input. No count, ordering, rank or OFFSET.
    format!("SELECT to_json(CASE {} END) FROM {} WHERE {scope}({}) LIMIT {}", cases.join(" "), identifier(&request.table_name), predicates.join(" OR "), RESULT_LIMIT + 1)
}

fn run_search(connection: &Connection, request: &TableSearchRequest, job: &SearchJob) -> AppResult<TableSearchResult> {
    if let Some(status) = job.stopped() { return Ok(TableSearchResult::stopped(status)); }
    // Check identifiers against the schema without scanning the data.
    let mut schema = connection.prepare(&format!("DESCRIBE {}", identifier(&request.table_name)))?;
    let names: HashSet<String> = schema.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<_, _>>()?;
    if request.columns.iter().any(|column| !names.contains(column)) { return Err(AppError::msg("The columns changed. Close search and try again.")); }
    if let Some(status) = job.stopped() { return Ok(TableSearchResult::stopped(status)); }
    let mut statement = connection.prepare(&search_sql(request))?;
    let mut rows = statement.query(params![request.term])?;
    let mut matches = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(status) = job.stopped() { return Ok(TableSearchResult::stopped(status)); }
        let json: String = row.get(0)?;
        let cell: SearchMatch = serde_json::from_str(&json)?;
        matches.push(cell);
        if matches.len() > RESULT_LIMIT { break; }
    }
    let has_more = matches.len() > RESULT_LIMIT;
    matches.truncate(RESULT_LIMIT);
    Ok(TableSearchResult { status: "complete", matches, has_more, limit: RESULT_LIMIT })
}

#[tauri::command]
pub async fn search_table(window: Window, db_state: State<'_, DbState>, searches: State<'_, TableSearchState>, request: TableSearchRequest) -> AppResult<TableSearchResult> {
    validate_request(&request)?;
    let label = window.label().to_string();
    let primary = db_state.get(&label)?;
    let job = match searches.reserve(&label, request.request_id, SEARCH_TIMEOUT) {
        Ok(job) => job,
        Err(status) => return Ok(TableSearchResult::stopped(status)),
    };
    job.monitor();
    let worker_job = job.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        // Wait for a short cloning opportunity, checking cancellation/deadline between attempts.
        // The primary mutex is held only for try_clone(), never for the scan.
        let connection = loop {
            if let Some(status) = worker_job.stopped() { return Ok(TableSearchResult::stopped(status)); }
            if let Some(primary) = primary.try_lock_for(Duration::from_millis(20)) { break primary.try_clone()?; }
        };
        worker_job.attach(&connection);
        run_search(&connection, &request, &worker_job)
    }).await;
    let stopped = job.finish();
    searches.release(&label, &job);
    if let Some(status) = stopped { return Ok(TableSearchResult::stopped(status)); }
    outcome.map_err(|error| AppError::msg(format!("Search worker failed: {error}")))?
}

#[tauri::command]
pub fn cancel_table_search(window: Window, searches: State<'_, TableSearchState>, request_id: u64) {
    searches.cancel(window.label(), request_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(term: &str) -> TableSearchRequest {
        TableSearchRequest { request_id: 1, table_name: "data".into(), columns: vec!["message".into()], term: term.into(), filter_sql: String::new() }
    }
    fn search(connection: &Connection, request: &TableSearchRequest) -> TableSearchResult {
        validate_request(request).unwrap();
        run_search(connection, request, &SearchJob::new(SEARCH_TIMEOUT)).unwrap()
    }

    #[test]
    fn literal_search_is_bounded_filtered_and_finds_late_matches() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE data AS SELECT CASE WHEN i = 0 THEN NULL ELSE repeat('x', 2000) || 'Don''t_100% NEEDLE' END AS message, i AS id FROM range(250) t(i)").unwrap();
        let mut request = request("don't_100% needle");
        request.filter_sql = "id >= 2".into();
        let result = search(&connection, &request);
        assert_eq!(result.matches.len(), RESULT_LIMIT);
        assert!(result.has_more);
        assert!(result.matches.iter().all(|cell| cell.preview.contains("Don't_100% NEEDLE") && cell.preview.chars().count() <= PREVIEW_CHARS && cell.truncated_start));
        request.filter_sql = "id = 0".into();
        assert!(search(&connection, &request).matches.is_empty());
        request.filter_sql = "id = 249".into();
        assert_eq!(search(&connection, &request).matches.len(), 1);
        request.term = "don'tx100Y needle".into();
        assert!(search(&connection, &request).matches.is_empty());
    }

    #[test]
    fn identifiers_and_first_matching_column_are_literal() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE data(\"quote\"\"column\" VARCHAR, message VARCHAR, rowid VARCHAR); INSERT INTO data VALUES ('100%_test', '100%_test', 'user rowid')").unwrap();
        let mut request = request("100%_test");
        request.columns = vec!["quote\"column".into(), "message".into()];
        let result = search(&connection, &request);
        assert_eq!(result.matches.len(), 1);
        assert_eq!(result.matches[0].column, "quote\"column");
        assert_eq!(result.matches[0].preview, "100%_test");
        let sql = search_sql(&request).to_uppercase();
        assert!(!sql.contains("COUNT(") && !sql.contains("ORDER BY") && !sql.contains("OFFSET") && !sql.contains("ROWID"));
    }

    #[test]
    fn bounds_are_native_and_more_flag_requires_extra_match() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE data AS SELECT 'hit' AS message FROM range(100)").unwrap();
        let result = search(&connection, &request("hit"));
        assert_eq!(result.matches.len(), 100);
        assert!(!result.has_more);
        let mut invalid = request("hit");
        invalid.columns = vec!["message".into(); MAX_COLUMNS + 1];
        assert!(validate_request(&invalid).is_err());
        invalid.columns = vec!["message".into()];
        invalid.term = "x".repeat(2049);
        assert!(validate_request(&invalid).is_err());
    }

    #[test]
    fn generations_isolate_windows_and_cancel_before_start() {
        let state = TableSearchState::default();
        state.cancel("main", 2);
        assert!(matches!(state.reserve("main", 2, SEARCH_TIMEOUT), Err("cancelled")));
        let main = state.reserve("main", 3, SEARCH_TIMEOUT).unwrap();
        let other = state.reserve("other", 1, SEARCH_TIMEOUT).unwrap();
        state.cancel("main", 2);
        assert_eq!(main.stopped(), None);
        assert!(matches!(state.reserve("main", 4, SEARCH_TIMEOUT), Err("busy")));
        assert_eq!(main.stopped(), Some("cancelled"));
        assert_eq!(other.stopped(), None);
        state.release("main", &main);
        let replacement = state.reserve("main", 5, SEARCH_TIMEOUT).unwrap();
        state.release("main", &main);
        assert!(state.windows.lock()["main"].job.as_ref().is_some_and(|job| Arc::ptr_eq(job, &replacement)));
        state.close_for("main");
        assert_eq!(replacement.stopped(), Some("cancelled"));
        assert!(!state.windows.lock().contains_key("main"));
    }

    #[test]
    fn cancellation_before_connection_attach_cannot_be_lost() {
        let connection = Connection::open_in_memory().unwrap();
        let job = SearchJob::new(SEARCH_TIMEOUT);
        job.monitor();
        job.cancel();
        job.attach(&connection);
        let result = run_search(&connection, &request("anything"), &job).unwrap();
        assert_eq!(result.status, "cancelled");
        assert_eq!(job.finish(), Some("cancelled"));
    }

    #[test]
    #[ignore = "manual 100M-row performance and bounded-payload check"]
    fn benchmark_100m_native_search() {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let path = std::env::temp_dir().join(format!("chikku-native-search-100m-{}-{stamp}.duckdb", std::process::id()));
        let connection = Connection::open(&path).unwrap();
        connection.execute_batch("SET memory_limit='512MB'; CREATE TABLE search_benchmark AS SELECT i::BIGINT AS id, CASE WHEN i = 99999999 THEN 'needle at end' ELSE 'ordinary value' END AS text_value FROM range(100000000) r(i)").unwrap();
        let mut request = request("ordinary");
        request.table_name = "search_benchmark".into();
        request.columns = vec!["text_value".into()];
        for term in ["ordinary", "needle at end", "absent marker"] {
            request.term = term.into();
            let started = Instant::now();
            let result = search(&connection, &request);
            let bytes = serde_json::to_vec(&result).unwrap().len();
            println!("100M narrow rows / {term:?}: {:?}, {} rows, {bytes} serialized bytes, capped={}", started.elapsed(), result.matches.len(), result.has_more);
            assert!(bytes < 100_000);
            match term {
                "ordinary" => { assert_eq!(result.matches.len(), 100); assert!(result.has_more); },
                "needle at end" => { assert_eq!(result.matches.len(), 1); assert!(!result.has_more); },
                _ => assert!(result.matches.is_empty()),
            }
        }
        drop(connection);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn active_cancellation_leaves_primary_and_other_connection_usable() {
        let primary = Connection::open_in_memory().unwrap();
        let isolated = primary.try_clone().unwrap();
        let other = primary.try_clone().unwrap();
        let job = SearchJob::new(SEARCH_TIMEOUT);
        job.attach(&isolated);
        job.monitor();
        let worker = std::thread::spawn(move || isolated.query_row("SELECT sum(sin(a.i * b.i)) FROM range(1000000) a(i), range(1000000) b(i)", [], |row| row.get::<_, f64>(0)));
        std::thread::sleep(Duration::from_millis(25));
        assert_eq!(primary.query_row("SELECT 42", [], |row| row.get::<_, i32>(0)).unwrap(), 42);
        job.cancel();
        assert!(worker.join().unwrap().is_err());
        assert_eq!(job.finish(), Some("cancelled"));
        assert_eq!(other.query_row("SELECT 7", [], |row| row.get::<_, i32>(0)).unwrap(), 7);
    }

    #[test]
    fn timeout_interrupts_clone_without_interrupting_primary() {
        let primary = Connection::open_in_memory().unwrap();
        let isolated = primary.try_clone().unwrap();
        let job = SearchJob::new(Duration::from_millis(50));
        job.attach(&isolated);
        job.monitor();
        let started = Instant::now();
        let result = isolated.query_row("SELECT sum(sin(a.i * b.i)) FROM range(1000000) a(i), range(1000000) b(i)", [], |row| row.get::<_, f64>(0));
        assert!(result.is_err());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(job.finish(), Some("timedOut"));
        assert_eq!(primary.query_row("SELECT 42", [], |row| row.get::<_, i32>(0)).unwrap(), 42);
    }
}
