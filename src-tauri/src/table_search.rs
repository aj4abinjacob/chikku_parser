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
    pub sort_columns: Vec<SearchSort>,
    pub direction: String,
    pub cursor_row: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSort {
    pub column: String,
    pub direction: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub row_index: u64,
    pub columns: Vec<String>,
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

fn validate_request(request: &TableSearchRequest) -> AppResult<()> {
    if request.request_id == 0 || request.request_id > 9_007_199_254_740_991 { return Err(AppError::msg("Invalid search request.")); }
    if request.term.is_empty() || request.term.chars().count() > 2048 { return Err(AppError::msg("Enter between 1 and 2,048 characters to search.")); }
    if request.columns.is_empty() { return Err(AppError::msg("Show a column before searching.")); }
    if request.columns.len() > MAX_COLUMNS { return Err(AppError::msg("Find supports up to 200 visible columns. Hide some columns to continue.")); }
    if request.table_name.len() > 4096 || request.columns.iter().any(|column| column.len() > 4096) || request.filter_sql.len() > 262_144 {
        return Err(AppError::msg("This search scope is too large. Choose a column or simplify the filters."));
    }
    if request.cursor_row > 9_007_199_254_740_991 || !matches!(request.direction.as_str(), "forward" | "backward") || request.sort_columns.len() > MAX_COLUMNS || request.sort_columns.iter().any(|sort| !matches!(sort.direction.as_str(), "ASC" | "DESC")) {
        return Err(AppError::msg("Invalid find position or ordering."));
    }
    Ok(())
}

// Keep the sorted tie rule identical to buildGridOrderClause in sqlBuilder.ts.
fn order_clause(request: &TableSearchRequest, names: &HashSet<String>) -> String {
    if request.sort_columns.is_empty() { return String::new(); }
    let mut parts: Vec<String> = request.sort_columns.iter().map(|sort| format!("{} {}", identifier(&sort.column), sort.direction)).collect();
    if !names.iter().any(|name| name.eq_ignore_ascii_case("rowid")) { parts.push("rowid ASC".into()); }
    else {
        for column in &request.columns {
            if !request.sort_columns.iter().any(|sort| sort.column == *column) { parts.push(format!("{} ASC", identifier(column))); }
        }
    }
    format!(" ORDER BY {}", parts.join(", "))
}

fn search_sql(request: &TableSearchRequest, names: &HashSet<String>) -> String {
    let mut position_name = "__chikku_find_position".to_string();
    while names.iter().any(|name| name.eq_ignore_ascii_case(&position_name)) { position_name.push('_'); }
    let position = identifier(&position_name);
    let columns = request.columns.iter().map(|column| identifier(column)).collect::<Vec<_>>().join(", ");
    let predicates: Vec<String> = request.columns.iter().map(|column| format!("COALESCE(contains(lower(CAST({} AS VARCHAR)), lower($1)), false)", identifier(column))).collect();
    let flags = predicates.join(", ");
    let filter = if request.filter_sql.is_empty() { String::new() } else { format!(" WHERE {}", request.filter_sql) };
    let order = order_clause(request, names);
    let comparison = if request.direction == "backward" { "<" } else { ">=" };
    let reverse = if request.direction == "backward" { format!(" ORDER BY {position} DESC") } else { String::new() };
    // Number the current filtered/sorted view BEFORE applying find predicates. The window
    // prevents predicate pushdown from turning positions into indices of matching rows.
    // No COUNT, OFFSET, values, JSON extensions, or unbounded IDs cross the bridge.
    format!("SELECT {position}, {flags} FROM (SELECT ROW_NUMBER() OVER () - 1 AS {position}, * FROM (SELECT {columns} FROM {}{filter}{order}) AS find_view) AS numbered_view WHERE {position} {comparison} {} AND ({}){reverse} LIMIT {}", identifier(&request.table_name), request.cursor_row, predicates.join(" OR "), RESULT_LIMIT + 1)
}

fn run_search(connection: &Connection, request: &TableSearchRequest, job: &SearchJob) -> AppResult<TableSearchResult> {
    if let Some(status) = job.stopped() { return Ok(TableSearchResult::stopped(status)); }
    // Check identifiers against the schema without scanning the data.
    let mut schema = connection.prepare(&format!("DESCRIBE {}", identifier(&request.table_name)))?;
    let names: HashSet<String> = schema.query_map([], |row| row.get::<_, String>(0))?.collect::<Result<_, _>>()?;
    if request.columns.iter().any(|column| !names.contains(column)) || request.sort_columns.iter().any(|sort| !names.contains(&sort.column)) { return Err(AppError::msg("The columns changed. Close search and try again.")); }
    if let Some(status) = job.stopped() { return Ok(TableSearchResult::stopped(status)); }
    let mut statement = connection.prepare(&search_sql(request, &names))?;
    let mut rows = statement.query(params![request.term])?;
    let mut matches = Vec::new();
    while let Some(row) = rows.next()? {
        if let Some(status) = job.stopped() { return Ok(TableSearchResult::stopped(status)); }
        let mut columns = Vec::new();
        for (index, column) in request.columns.iter().enumerate() {
            if row.get::<_, bool>(index + 1)? { columns.push(column.clone()); }
        }
        matches.push(SearchMatch { row_index: row.get::<_, i64>(0)? as u64, columns });
        if matches.len() > RESULT_LIMIT { break; }
    }
    let has_more = matches.len() > RESULT_LIMIT;
    matches.truncate(RESULT_LIMIT);
    if request.direction == "backward" { matches.reverse(); }
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
        TableSearchRequest { request_id: 1, table_name: "data".into(), columns: vec!["message".into()], term: term.into(), filter_sql: String::new(), sort_columns: Vec::new(), direction: "forward".into(), cursor_row: 0 }
    }
    fn search(connection: &Connection, request: &TableSearchRequest) -> TableSearchResult {
        validate_request(request).unwrap();
        run_search(connection, request, &SearchJob::new(SEARCH_TIMEOUT)).unwrap()
    }

    #[test]
    fn literal_find_returns_filtered_positions_and_every_matching_column() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE data AS SELECT i AS id, CASE WHEN i=0 THEN NULL ELSE repeat('x', 2000) || 'Don''t_100% NÉEDLE' END AS message, 'NÉEDLE' AS other FROM range(250) t(i)").unwrap();
        let mut request = request("don't_100% néedle");
        request.filter_sql = "id >= 2".into();
        let result = search(&connection, &request);
        assert_eq!(result.matches.len(), RESULT_LIMIT);
        assert!(result.has_more);
        assert_eq!(result.matches[0].row_index, 0);
        assert_eq!(result.matches[99].row_index, 99);
        request.cursor_row = 100;
        assert_eq!(search(&connection, &request).matches[0].row_index, 100);
        request.direction = "backward".into();
        let previous = search(&connection, &request);
        assert_eq!(previous.matches[0].row_index, 0);
        assert_eq!(previous.matches[99].row_index, 99);
        assert!(!previous.has_more);
        request.direction = "forward".into(); request.cursor_row = 0;
        request.columns.push("other".into()); request.term = "néedle".into();
        assert_eq!(search(&connection, &request).matches[0].columns, vec!["message", "other"]);
        request.filter_sql = "id = 0".into();
        assert_eq!(search(&connection, &request).matches[0].columns, vec!["other"]);
        request.term = "don'tx100Y néedle".into();
        assert!(search(&connection, &request).matches.is_empty());
    }

    #[test]
    fn find_positions_match_chunk_order_for_sort_ties_filters_nulls_and_shadowed_rowid() {
        for shadow in [false, true] {
            let connection = Connection::open_in_memory().unwrap();
            connection.execute_batch("CREATE TABLE data AS SELECT i AS id, CASE WHEN i%3=0 THEN NULL ELSE i%4 END AS sort_key, '[hit ' || i::VARCHAR || ']' AS message FROM range(512) t(i)").unwrap();
            if shadow { connection.execute_batch("ALTER TABLE data ADD COLUMN rowid VARCHAR DEFAULT 'user row id'").unwrap(); }
            let mut request = request("hit");
            request.columns = vec!["id".into(), "message".into()];
            request.filter_sql = "id % 2 = 1".into();
            request.sort_columns = vec![SearchSort { column: "sort_key".into(), direction: "DESC".into() }];
            let names: HashSet<String> = ["id", "message", "sort_key"].into_iter().chain(if shadow { Some("rowid") } else { None }).map(str::to_string).collect();
            let expected: Vec<i64> = connection.prepare(&format!("SELECT id FROM data WHERE id % 2 = 1{}", order_clause(&request, &names))).unwrap().query_map([], |row| row.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
            for cursor in [0_u64, 100, 200] {
                request.cursor_row = cursor;
                let matches = search(&connection, &request);
                assert_eq!(matches.matches[0].row_index, cursor);
                assert_eq!(matches.matches.len(), std::cmp::min(100, expected.len() - cursor as usize));
                for found in matches.matches.iter().step_by(37) {
                    let row = found.row_index as usize;
                    request.term = format!("[hit {}]", expected[row]);
                    let exact = search(&connection, &request);
                    assert_eq!(exact.matches.len(), 1);
                    assert_eq!(exact.matches[0].row_index, row as u64);
                    assert_eq!(exact.matches[0].columns, vec!["message"]);
                }
                request.term = "hit".into();
            }
        }
    }

    #[test]
    fn no_sort_find_positions_match_insertion_order_after_filtering() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE data AS SELECT i AS id, CASE WHEN i=149999 THEN 'needle' ELSE 'ordinary' END AS message FROM range(150000) t(i)").unwrap();
        let mut request = request("needle"); request.filter_sql = "id % 2 = 1".into();
        assert_eq!(search(&connection, &request).matches[0].row_index, 74999);
        let sql = search_sql(&request, &HashSet::new()).to_uppercase();
        assert!(!sql.contains("ORDER BY") && !sql.contains("OFFSET") && !sql.contains("COUNT("));
    }

    #[test]
    fn decimal_transport_chunks_and_find_share_numeric_order_and_ties() {
        for shadow in [false, true] {
            let connection = Connection::open_in_memory().unwrap();
            connection.execute_batch("CREATE TABLE data(amount DECIMAL(38,10), message VARCHAR); INSERT INTO data VALUES (10, '[hit D]'), (2, '[hit B]'), (10, '[hit C]'), (2, '[hit A]')").unwrap();
            if shadow { connection.execute_batch("ALTER TABLE data ADD COLUMN ROWID VARCHAR DEFAULT 'user row id'").unwrap(); }
            let mut request = request("hit");
            request.columns = vec!["amount".into(), "message".into()];
            request.sort_columns = vec![SearchSort { column: "amount".into(), direction: "ASC".into() }];
            // This is the chunk projection: preserve exact decimals as text, but
            // qualify ORDER BY against the source to avoid sorting its alias.
            let tie = if shadow { "data.message ASC" } else { "data.rowid ASC" };
            let sql = format!("SELECT CAST(amount AS VARCHAR) AS amount, message FROM data ORDER BY data.amount ASC, {tie} LIMIT 100 OFFSET 0");
            let chunk: Vec<(String, String)> = connection.prepare(&sql).unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().collect::<Result<_, _>>().unwrap();
            assert_eq!(chunk.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(), vec!["2.0000000000", "2.0000000000", "10.0000000000", "10.0000000000"]);
            assert_eq!(chunk.iter().map(|row| row.1.as_str()).collect::<Vec<_>>(), if shadow { vec!["[hit A]", "[hit B]", "[hit C]", "[hit D]"] } else { vec!["[hit B]", "[hit A]", "[hit D]", "[hit C]"] });
            for (position, (_, message)) in chunk.iter().enumerate() {
                request.term = message.clone();
                let result = search(&connection, &request);
                assert_eq!(result.matches.len(), 1);
                assert_eq!(result.matches[0].row_index, position as u64);
                assert_eq!(result.matches[0].columns, vec!["message"]);
            }
        }
    }

    #[test]
    fn search_uses_core_functions_and_collision_safe_identifiers() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("SET autoload_known_extensions = false; SET autoinstall_known_extensions = false; CREATE TABLE data(\"quote\"\"column\" VARCHAR, message VARCHAR, rowid VARCHAR, __CHIKKU_FIND_POSITION VARCHAR); INSERT INTO data VALUES ('100%_test', '100%_test', 'user', 'value')").unwrap();
        let mut request = request("100%_test"); request.columns = vec!["quote\"column".into(), "message".into()];
        let result = search(&connection, &request);
        assert_eq!(result.matches[0].columns, request.columns);
        assert_eq!(result.matches[0].row_index, 0);
        let sql = search_sql(&request, &HashSet::new()).to_uppercase();
        assert!(!sql.contains("JSON_") && !sql.contains("TO_JSON("));
        assert!(sql.contains("LIMIT 101"));
    }

    #[test]
    fn unicode_simple_lowercase_agrees_with_grid_highlights() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE data AS SELECT 'İstanbul ΟΣ' AS message").unwrap();
        assert_eq!(search(&connection, &request("istanbul οσ")).matches[0].row_index, 0);
    }

    #[test]
    fn bounds_are_native_and_more_flag_requires_extra_match() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE data AS SELECT 'hit' AS message FROM range(100)").unwrap();
        let result = search(&connection, &request("hit"));
        assert_eq!(result.matches.len(), 100); assert!(!result.has_more);
        let mut invalid = request("hit"); invalid.columns = vec!["message".into(); MAX_COLUMNS + 1];
        assert!(validate_request(&invalid).is_err());
        invalid.columns = vec!["message".into()]; invalid.term = "x".repeat(2049);
        assert!(validate_request(&invalid).is_err());
        invalid.term = "hit".into(); invalid.direction = "sideways".into();
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
                "needle at end" => { assert_eq!(result.matches.len(), 1); assert_eq!(result.matches[0].row_index, 99_999_999); assert!(!result.has_more); },
                _ => assert!(result.matches.is_empty()),
            }
        }
        request.term = "ordinary".into();
        request.cursor_row = 100;
        assert_eq!(search(&connection, &request).matches[0].row_index, 100);
        request.direction = "backward".into(); request.cursor_row = 100_000_000;
        let started = Instant::now();
        let tail = search(&connection, &request);
        println!("100M narrow rows / backward wrap: {:?}, {} positions, capped={}", started.elapsed(), tail.matches.len(), tail.has_more);
        assert_eq!(tail.matches.first().unwrap().row_index, 99_999_899);
        assert_eq!(tail.matches.last().unwrap().row_index, 99_999_998);
        assert!(tail.has_more);
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
