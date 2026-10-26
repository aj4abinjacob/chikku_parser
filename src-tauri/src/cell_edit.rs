//! Exact, bounded single-cell reads and optimistic edits. The connection lock covers
//! schema validation, conflict checks and the write; no table snapshots are needed.
use crate::db::DbState;
use crate::error::{AppError, AppResult};
use duckdb::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{State, Window};

pub const MAX_CELL_EDIT_BYTES: usize = 1_048_576;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCellValueRequest {
    table_name: String,
    column_name: String,
    row_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadCellValueResult {
    value: Option<String>,
    column_type: String,
    editable: bool,
    reason: Option<String>,
    revision: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCellEditRequest {
    table_name: String,
    column_name: String,
    row_id: String,
    expected_value: Option<String>,
    value: Option<String>,
    revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCellEditResult {
    value: Option<String>,
    column_type: String,
    revision: String,
    sql_statements: Vec<String>,
}

fn identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn literal(value: Option<&str>) -> String {
    match value {
        None => "NULL".into(),
        // Embedded NUL cannot be represented safely in a SQL source literal.
        Some(value) if value.contains('\0') => {
            let mut hex = String::with_capacity(value.len() * 2);
            for byte in value.as_bytes() {
                use std::fmt::Write;
                write!(&mut hex, "{byte:02x}").unwrap();
            }
            format!("decode(from_hex('{hex}'))")
        }
        Some(value) => format!("'{}'", value.replace('\'', "''")),
    }
}

fn row_id(table: &str, column: &str, value: &str) -> AppResult<i64> {
    if table.is_empty()
        || column.is_empty()
        || table.len() > 4096
        || column.len() > 4096
        || table.contains('\0')
        || column.contains('\0')
    {
        return Err(AppError::msg("The table or column name is invalid."));
    }
    if value.is_empty() || value.len() > 19 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(AppError::msg(
            "This cell has no valid source row identity. Refresh the table and try again.",
        ));
    }
    value.parse().map_err(|_| {
        AppError::msg(
            "This cell has no valid source row identity. Refresh the table and try again.",
        )
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ScalarType {
    Text,
    Boolean,
    Integer,
    Decimal,
    Float,
    Temporal,
    Uuid,
}

fn scalar_type(column_type: &str) -> Option<ScalarType> {
    Some(match column_type {
        "VARCHAR" => ScalarType::Text,
        "BOOLEAN" => ScalarType::Boolean,
        "TINYINT" | "SMALLINT" | "INTEGER" | "BIGINT" | "HUGEINT" | "UTINYINT" | "USMALLINT"
        | "UINTEGER" | "UBIGINT" | "UHUGEINT" => ScalarType::Integer,
        "FLOAT" | "DOUBLE" => ScalarType::Float,
        "DATE"
        | "TIME"
        | "TIME WITH TIME ZONE"
        | "TIMESTAMP"
        | "TIMESTAMP_S"
        | "TIMESTAMP_MS"
        | "TIMESTAMP_NS"
        | "TIMESTAMP WITH TIME ZONE" => ScalarType::Temporal,
        "UUID" => ScalarType::Uuid,
        value if decimal_type(value) => ScalarType::Decimal,
        _ => return None,
    })
}

fn decimal_type(value: &str) -> bool {
    let Some(inner) = value
        .strip_prefix("DECIMAL(")
        .or_else(|| value.strip_prefix("NUMERIC("))
        .and_then(|value| value.strip_suffix(')'))
    else {
        return false;
    };
    let Some((precision, scale)) = inner.split_once(',') else {
        return false;
    };
    match (precision.parse::<u8>(), scale.trim().parse::<u8>()) {
        (Ok(precision), Ok(scale)) => (1..=38).contains(&precision) && scale <= precision,
        _ => false,
    }
}

struct CellSchema {
    column_type: String,
    scalar_type: Option<ScalarType>,
    reason: Option<String>,
    row_alias: String,
}

fn cell_schema(conn: &Connection, table: &str, column: &str) -> AppResult<CellSchema> {
    let mut stmt = conn
        .prepare(&format!("DESCRIBE {}", identifier(table)))
        .map_err(|_| {
            AppError::msg("This table is no longer available. Refresh the table and try again.")
        })?;
    let mut rows = stmt.query([])?;
    let mut column_type = None;
    let mut has_rowid_column = false;
    let mut column_names = Vec::new();
    while let Some(row) = rows.next()? {
        let name: String = row.get(0)?;
        if name.eq_ignore_ascii_case("rowid") {
            has_rowid_column = true;
        }
        if name == column {
            column_type = Some(row.get::<_, String>(1)?);
        }
        column_names.push(name);
    }
    let column_type = column_type.ok_or_else(|| {
        AppError::msg("This column is no longer available. Refresh the table and try again.")
    })?;
    let scalar_type = scalar_type(&column_type);
    let mut tables = conn.prepare("SELECT index_count FROM duckdb_tables() WHERE table_name = ? AND schema_name = current_schema() AND (database_name = current_database() OR temporary) ORDER BY temporary DESC LIMIT 1")?;
    let mut table_rows = tables.query(params![table])?;
    let index_count = match table_rows.next()? {
        Some(row) => Some(row.get::<_, i64>(0)?),
        None => None,
    };
    let reason = if index_count.is_none() {
        Some("Views are read-only. Edit the source table instead.".into())
    } else if has_rowid_column {
        Some("This table has a column named rowid, so source rows cannot be identified safely for editing.".into())
    } else if index_count.unwrap_or(0) > 0 {
        Some("Tables with indexes or key constraints are read-only because updates can change source row identities.".into())
    } else if scalar_type.is_none() {
        Some(format!("{column_type} values are read-only. Cell editing supports text, booleans, numbers, dates, times and UUIDs."))
    } else {
        None
    };
    let mut row_alias = "__chikku_edit_source".to_string();
    while column_names
        .iter()
        .any(|name| name.eq_ignore_ascii_case(&row_alias))
    {
        row_alias.push('_');
    }
    Ok(CellSchema {
        column_type,
        scalar_type,
        reason,
        row_alias,
    })
}

/// The predicate uses DuckDB's physical row identity and returns at most two rows.
/// Oversize text stays in DuckDB instead of crossing the process boundary.
fn canonical_cell(
    conn: &Connection,
    table: &str,
    column: &str,
    rowid: i64,
) -> AppResult<(Option<String>, bool)> {
    let text = format!("CAST({} AS VARCHAR)", identifier(column));
    let oversized =
        format!("COALESCE(octet_length(encode({text})) > {MAX_CELL_EDIT_BYTES}, false)");
    let sql = format!("SELECT CASE WHEN {oversized} THEN NULL ELSE {text} END, {oversized} FROM {} WHERE rowid = ? LIMIT 2", identifier(table));
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(params![rowid])?;
    let row = rows.next()?.ok_or_else(|| {
        AppError::msg("This source row no longer exists. Refresh the table and try again.")
    })?;
    let result = (row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?);
    if rows.next()?.is_some() {
        return Err(AppError::msg(
            "The source row cannot be identified uniquely. Refresh the table and try again.",
        ));
    }
    Ok(result)
}

fn read_cell(
    conn: &Connection,
    state: &DbState,
    request: &ReadCellValueRequest,
) -> AppResult<ReadCellValueResult> {
    let rowid = row_id(&request.table_name, &request.column_name, &request.row_id)?;
    let schema = cell_schema(conn, &request.table_name, &request.column_name)?;
    // In particular, never SELECT using a shadowed physical rowid or from a view.
    if let Some(reason) = schema.reason {
        return Ok(ReadCellValueResult {
            value: None,
            column_type: schema.column_type,
            editable: false,
            reason: Some(reason),
            revision: state.revision(),
        });
    }
    let (value, oversized) =
        canonical_cell(conn, &request.table_name, &request.column_name, rowid)?;
    Ok(ReadCellValueResult {
        value,
        column_type: schema.column_type,
        editable: !oversized,
        reason: oversized.then(|| "This value exceeds the 1 MiB cell editing limit.".into()),
        revision: state.revision(),
    })
}

/// Normalize arbitrary-precision plain decimal text without going through a float.
fn normalized_decimal(value: &str) -> Option<String> {
    let (negative, digits) = if let Some(value) = value.strip_prefix('-') {
        (true, value)
    } else {
        (false, value.strip_prefix('+').unwrap_or(value))
    };
    let (whole, fraction) = digits.split_once('.').unwrap_or((digits, ""));
    if whole.is_empty() && fraction.is_empty() {
        return None;
    }
    if !whole
        .bytes()
        .chain(fraction.bytes())
        .all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let whole = whole.trim_start_matches('0');
    let fraction = fraction.trim_end_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let sign = if negative && (whole != "0" || !fraction.is_empty()) {
        "-"
    } else {
        ""
    };
    Some(if fraction.is_empty() {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    })
}

fn validate_temporal_precision(column_type: &str, value: &str) -> AppResult<()> {
    if value.eq_ignore_ascii_case("infinity") || value.eq_ignore_ascii_case("-infinity") {
        return Ok(());
    }
    if column_type == "DATE" {
        // DuckDB accepts a timestamp as DATE and silently removes the time.
        let date = value.strip_suffix(" (BC)").unwrap_or(value);
        if date
            .bytes()
            .any(|byte| byte.is_ascii_whitespace() || byte == b'T' || byte == b't' || byte == b'.')
        {
            return Err(AppError::msg("Enter a date without a time component."));
        }
        return Ok(());
    }
    let precision = match column_type {
        "TIMESTAMP_S" => 0,
        "TIMESTAMP_MS" => 3,
        "TIMESTAMP_NS" => 9,
        _ => 6,
    };
    if let Some((_, fraction)) = value.split_once('.') {
        if fraction
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .skip(precision)
            .any(|byte| byte != b'0')
        {
            return Err(AppError::msg(format!("This value would lose time precision in {column_type}. Use at most {precision} fractional second digits.")));
        }
    }
    Ok(())
}

fn validated_value(
    conn: &Connection,
    column_type: &str,
    kind: ScalarType,
    value: Option<&str>,
) -> AppResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.len() > MAX_CELL_EDIT_BYTES {
        return Err(AppError::msg(
            "The new value exceeds the 1 MiB cell editing limit.",
        ));
    }
    match kind {
        ScalarType::Integer => {
            let digits = value
                .strip_prefix('-')
                .or_else(|| value.strip_prefix('+'))
                .unwrap_or(value);
            if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(AppError::msg(
                    "Enter a whole number without spaces, a fraction or an exponent.",
                ));
            }
        }
        ScalarType::Decimal if normalized_decimal(value).is_none() => {
            return Err(AppError::msg(
                "Enter a decimal number without spaces or an exponent.",
            ));
        }
        ScalarType::Boolean
            if !value.eq_ignore_ascii_case("true") && !value.eq_ignore_ascii_case("false") =>
        {
            return Err(AppError::msg("Enter true or false, or choose NULL."));
        }
        ScalarType::Float => {
            if value.is_empty()
                || value.trim() != value
                || !value.parse::<f64>().is_ok_and(|number| number.is_finite())
            {
                return Err(AppError::msg(
                    "Enter a finite number within this column's range.",
                ));
            }
        }
        ScalarType::Temporal | ScalarType::Uuid if value.is_empty() || value.trim() != value => {
            return Err(AppError::msg(format!(
                "Enter a valid {column_type} value without surrounding spaces, or choose NULL."
            )));
        }
        _ => {}
    }
    if kind == ScalarType::Temporal {
        validate_temporal_precision(column_type, value)?;
    }
    // column_type comes exclusively from the schema and the scalar whitelist.
    let sql = format!("SELECT CAST(CAST(? AS {column_type}) AS VARCHAR)");
    let canonical: String = conn
        .query_row(&sql, params![value], |row| row.get(0))
        .map_err(|_| {
            AppError::msg(format!(
                "This value is not valid for {column_type}, or is outside its allowed range."
            ))
        })?;
    if canonical.len() > MAX_CELL_EDIT_BYTES {
        return Err(AppError::msg(
            "The converted value exceeds the 1 MiB cell editing limit.",
        ));
    }
    if kind == ScalarType::Decimal && normalized_decimal(value) != normalized_decimal(&canonical) {
        return Err(AppError::msg(format!("This value would lose decimal precision in {column_type}. Enter fewer fractional digits.")));
    }
    if kind == ScalarType::Float {
        let finite: bool = conn.query_row(
            &format!("SELECT isfinite(CAST(? AS {column_type}))"),
            params![value],
            |row| row.get(0),
        )?;
        if !finite {
            return Err(AppError::msg(
                "Enter a finite number within this column's range.",
            ));
        }
    }
    Ok(Some(canonical))
}

fn history_sql(
    table: &str,
    column: &str,
    rowid: i64,
    column_type: &str,
    old: Option<&str>,
    new: Option<&str>,
    row_alias: &str,
    row_fingerprint: &str,
) -> Vec<String> {
    let table_ident = identifier(table);
    let column_ident = identifier(column);
    let table_literal = literal(Some(table));
    let column_literal = literal(Some(column));
    let type_literal = literal(Some(column_type));
    let row_alias = identifier(row_alias);
    // The first statement fails visibly on a changed schema, row or original value.
    // Each statement is replayable by the existing serial TableHistory executor.
    let guard = format!(
        "SELECT CASE WHEN (SELECT COUNT(*) FROM duckdb_tables() WHERE table_name = {table_literal} AND schema_name = current_schema() AND (database_name = current_database() OR temporary) AND index_count = 0) = 1 AND NOT EXISTS (SELECT 1 FROM duckdb_columns() WHERE table_name = {table_literal} AND schema_name = current_schema() AND lower(column_name) = 'rowid') AND EXISTS (SELECT 1 FROM duckdb_columns() WHERE table_name = {table_literal} AND schema_name = current_schema() AND column_name = {column_literal} AND data_type = {type_literal}) AND (SELECT COUNT(*) FROM {table_ident} WHERE rowid = {rowid} AND encode(CAST({column_ident} AS VARCHAR)) IS NOT DISTINCT FROM encode({})) = 1 AND (SELECT CAST(hash({row_alias}) AS VARCHAR) FROM {table_ident} AS {row_alias} WHERE {row_alias}.rowid = {rowid}) = '{row_fingerprint}' THEN true ELSE error('Cell edit history conflict: the source row, value or schema has changed.') END",
        literal(old)
    );
    let update = format!(
        "UPDATE {table_ident} SET {column_ident} = CAST({} AS {column_type}) WHERE rowid = {rowid}",
        literal(new)
    );
    vec![guard, update]
}

fn apply_edit(
    conn: &Connection,
    state: &DbState,
    request: &ApplyCellEditRequest,
) -> AppResult<ApplyCellEditResult> {
    let rowid = row_id(&request.table_name, &request.column_name, &request.row_id)?;
    if request.revision != state.revision() {
        return Err(AppError::msg("The table changed after this cell was opened. Reopen the cell to edit its current value."));
    }
    if request
        .expected_value
        .as_ref()
        .is_some_and(|value| value.len() > MAX_CELL_EDIT_BYTES)
    {
        return Err(AppError::msg(
            "The original value exceeds the 1 MiB cell editing limit.",
        ));
    }
    let schema = cell_schema(conn, &request.table_name, &request.column_name)?;
    if let Some(reason) = schema.reason {
        return Err(AppError::msg(reason));
    }
    let (original, oversized) =
        canonical_cell(conn, &request.table_name, &request.column_name, rowid)?;
    if oversized {
        return Err(AppError::msg(
            "This value exceeds the 1 MiB cell editing limit.",
        ));
    }
    if original != request.expected_value {
        return Err(AppError::msg(
            "This cell's value changed after it was opened. Reopen the cell before editing.",
        ));
    }
    let canonical = validated_value(
        conn,
        &schema.column_type,
        schema.scalar_type.unwrap(),
        request.value.as_deref(),
    )?;
    // A physical rowid alone is not an identity across a source-file re-import.
    // Hash the one source row in DuckDB, including hidden columns, so replay
    // rejects reordered non-identical records without copying rows to JS or
    // allocating an identity column for the entire table. Engine-version hash
    // changes conservatively produce a history conflict rather than a write.
    let row_alias = identifier(&schema.row_alias);
    let fingerprint: String = conn.query_row(
        &format!("SELECT CAST(hash({row_alias}) AS VARCHAR) FROM {} AS {row_alias} WHERE {row_alias}.rowid = ?", identifier(&request.table_name)),
        params![rowid],
        |row| row.get(0),
    )?;
    let statements = history_sql(
        &request.table_name,
        &request.column_name,
        rowid,
        &schema.column_type,
        original.as_deref(),
        canonical.as_deref(),
        &schema.row_alias,
        &fingerprint,
    );
    let transaction = conn.unchecked_transaction().map_err(|_| {
        AppError::msg("The cell could not be edited while another transaction is open.")
    })?;
    let sql = format!(
        "UPDATE {} SET {} = CAST(? AS {}) WHERE rowid = ?",
        identifier(&request.table_name),
        identifier(&request.column_name),
        schema.column_type
    );
    let affected = transaction
        .execute(&sql, params![request.value, rowid])
        .map_err(|_| {
            AppError::msg(format!(
                "This value could not be applied to {}. Check the value and column constraints.",
                schema.column_type
            ))
        })?;
    if affected != 1 {
        return Err(AppError::msg("The source row changed before the edit could be applied. Refresh the table and try again."));
    }
    let (applied, oversized) = canonical_cell(
        &transaction,
        &request.table_name,
        &request.column_name,
        rowid,
    )?;
    if oversized || applied != canonical {
        return Err(AppError::msg(
            "The converted value did not match the requested edit. No change was applied.",
        ));
    }
    transaction.commit()?;
    state.invalidate_cell_edits();
    Ok(ApplyCellEditResult {
        value: applied,
        column_type: schema.column_type,
        revision: state.revision(),
        sql_statements: statements,
    })
}

#[tauri::command]
pub fn read_cell_value(
    window: Window,
    db_state: State<'_, DbState>,
    request: ReadCellValueRequest,
) -> AppResult<ReadCellValueResult> {
    let arc = db_state.get(window.label())?;
    let conn = arc.lock();
    read_cell(&conn, &db_state, &request)
}

#[tauri::command]
pub fn apply_cell_edit(
    window: Window,
    db_state: State<'_, DbState>,
    request: ApplyCellEditRequest,
) -> AppResult<ApplyCellEditResult> {
    let arc = db_state.get(window.label())?;
    let conn = arc.lock();
    apply_edit(&conn, &db_state, &request)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database(sql: &str) -> (Connection, DbState) {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "SET autoload_known_extensions = false; SET autoinstall_known_extensions = false",
        )
        .unwrap();
        conn.execute_batch(sql).unwrap();
        (conn, DbState::default())
    }

    fn read(
        conn: &Connection,
        state: &DbState,
        table: &str,
        column: &str,
        rowid: &str,
    ) -> ReadCellValueResult {
        read_cell(
            conn,
            state,
            &ReadCellValueRequest {
                table_name: table.into(),
                column_name: column.into(),
                row_id: rowid.into(),
            },
        )
        .unwrap()
    }

    fn request(
        conn: &Connection,
        state: &DbState,
        table: &str,
        column: &str,
        rowid: &str,
        value: Option<&str>,
    ) -> ApplyCellEditRequest {
        let original = read(conn, state, table, column, rowid);
        assert!(original.editable, "{:?}", original.reason);
        ApplyCellEditRequest {
            table_name: table.into(),
            column_name: column.into(),
            row_id: rowid.into(),
            expected_value: original.value,
            value: value.map(str::to_string),
            revision: original.revision,
        }
    }

    fn replay(conn: &Connection, statements: &[String]) -> AppResult<()> {
        for sql in statements {
            conn.execute_batch(sql)?;
        }
        Ok(())
    }

    #[test]
    fn cell_edit_targets_physical_rowid_even_when_display_is_sorted() {
        let (conn, state) = database(
            "CREATE TABLE data(value VARCHAR); INSERT INTO data VALUES ('z'), ('a'), ('m')",
        );
        let displayed_first_rowid: String = conn
            .query_row(
                "SELECT CAST(rowid AS VARCHAR) FROM data ORDER BY value LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(displayed_first_rowid, "1");
        let edit = request(
            &conn,
            &state,
            "data",
            "value",
            &displayed_first_rowid,
            Some("new"),
        );
        apply_edit(&conn, &state, &edit).unwrap();
        assert_eq!(
            read(&conn, &state, "data", "value", "0").value.as_deref(),
            Some("z")
        );
        assert_eq!(
            read(&conn, &state, "data", "value", "1").value.as_deref(),
            Some("new")
        );
    }

    #[test]
    fn cell_edit_checks_revisions_and_expected_value_without_mutating() {
        let (conn, state) =
            database("CREATE TABLE data(value VARCHAR); INSERT INTO data VALUES ('old')");
        let mut edit = request(&conn, &state, "data", "value", "0", Some("new"));
        assert!(state
            .exec_mutation(&conn, "SELECT missing_column FROM data")
            .is_err());
        assert!(apply_edit(&conn, &state, &edit)
            .unwrap_err()
            .to_string()
            .contains("table changed"));
        edit.revision = state.revision();
        edit.expected_value = Some("wrong".into());
        assert!(apply_edit(&conn, &state, &edit)
            .unwrap_err()
            .to_string()
            .contains("value changed"));
        assert_eq!(
            read(&conn, &state, "data", "value", "0").value.as_deref(),
            Some("old")
        );
        edit.expected_value = Some("old".into());
        let result = apply_edit(&conn, &state, &edit).unwrap();
        assert_ne!(result.revision, edit.revision);
        assert!(apply_edit(&conn, &state, &edit).is_err());
    }

    #[test]
    fn cell_edit_readonly_schema_and_shadowed_rowid_are_rejected() {
        let (conn, state) = database("CREATE TABLE shadow(ROWID BIGINT, value VARCHAR); INSERT INTO shadow VALUES (0, 'first'), (0, 'second'); CREATE TABLE indexed(value VARCHAR UNIQUE); INSERT INTO indexed VALUES ('old'); CREATE TABLE nested(value INTEGER[]); INSERT INTO nested VALUES ([1,2]); CREATE TABLE blobs(value BLOB); INSERT INTO blobs VALUES ('abc'); CREATE VIEW view_data AS SELECT * FROM shadow");
        for (table, column, message) in [
            ("shadow", "value", "rowid"),
            ("indexed", "value", "indexes"),
            ("nested", "value", "read-only"),
            ("blobs", "value", "read-only"),
            ("view_data", "value", "Views"),
        ] {
            let result = read(&conn, &state, table, column, "0");
            assert!(!result.editable);
            assert_eq!(result.value, None);
            assert!(result.reason.unwrap().contains(message));
            let edit = ApplyCellEditRequest {
                table_name: table.into(),
                column_name: column.into(),
                row_id: "0".into(),
                expected_value: None,
                value: Some("new".into()),
                revision: state.revision(),
            };
            assert!(apply_edit(&conn, &state, &edit).is_err());
        }
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM shadow WHERE value IN ('first','second')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn cell_edit_distinguishes_null_empty_and_preserves_text_whitespace() {
        let (conn, state) =
            database("CREATE TABLE data(value VARCHAR); INSERT INTO data VALUES (NULL)");
        for value in [Some(""), Some("  spaced\ntext  "), None] {
            let edit = request(&conn, &state, "data", "value", "0", value);
            let result = apply_edit(&conn, &state, &edit).unwrap();
            assert_eq!(result.value.as_deref(), value);
            assert_eq!(
                read(&conn, &state, "data", "value", "0").value.as_deref(),
                value
            );
        }
    }

    #[test]
    fn cell_edit_escaped_names_values_and_embedded_nul_replay_exactly() {
        let setup = "CREATE TABLE \"table'\"\"name\"(\"col'\"\"name\" VARCHAR); INSERT INTO \"table'\"\"name\" VALUES ('old''value')";
        let (conn, state) = database(setup);
        let edit = request(
            &conn,
            &state,
            "table'\"name",
            "col'\"name",
            "0",
            Some("new'quote\0tail\ntext"),
        );
        let result = apply_edit(&conn, &state, &edit).unwrap();
        assert_eq!(result.value.as_deref(), edit.value.as_deref());
        assert!(result.sql_statements[1].contains("decode(from_hex("));
        let (replayed, replay_state) = database(setup);
        replay(&replayed, &result.sql_statements).unwrap();
        assert_eq!(
            read(&replayed, &replay_state, "table'\"name", "col'\"name", "0").value,
            edit.value
        );
        let reverse = request(
            &conn,
            &state,
            "table'\"name",
            "col'\"name",
            "0",
            Some("next"),
        );
        let reverse_result = apply_edit(&conn, &state, &reverse).unwrap();
        assert!(reverse_result.sql_statements[0].contains("decode(from_hex("));
        replay(&replayed, &reverse_result.sql_statements).unwrap();
        assert_eq!(
            read(&replayed, &replay_state, "table'\"name", "col'\"name", "0")
                .value
                .as_deref(),
            Some("next")
        );
        assert!(replay(&replayed, &result.sql_statements)
            .unwrap_err()
            .to_string()
            .contains("history conflict"));
    }

    #[test]
    fn cell_edit_history_conflict_checks_ignore_column_collation() {
        let setup =
            "CREATE TABLE data(value VARCHAR COLLATE NOCASE); INSERT INTO data VALUES ('Old')";
        let (conn, state) = database(setup);
        let edit = request(&conn, &state, "data", "value", "0", Some("New"));
        let result = apply_edit(&conn, &state, &edit).unwrap();
        let (replayed, _) = database(setup);
        replayed
            .execute_batch("UPDATE data SET value = 'old'")
            .unwrap();
        assert!(replay(&replayed, &result.sql_statements)
            .unwrap_err()
            .to_string()
            .contains("history conflict"));
    }

    #[test]
    fn cell_edit_history_rejects_reordered_rows_with_the_same_edited_value() {
        let setup = "CREATE TABLE data(id INTEGER, value VARCHAR, __chikku_edit_source VARCHAR, details INTEGER[]); INSERT INTO data VALUES (1, 'same', 'first', [1, 2]), (2, 'same', 'second', [3, 4])";
        let (conn, state) = database(setup);
        let edit = request(&conn, &state, "data", "value", "0", Some("corrected"));
        let result = apply_edit(&conn, &state, &edit).unwrap();
        let (replayed, replay_state) = database(setup);
        replayed
            .execute_batch("CREATE OR REPLACE TABLE data AS SELECT * FROM data ORDER BY id DESC")
            .unwrap();
        assert!(replay(&replayed, &result.sql_statements)
            .unwrap_err()
            .to_string()
            .contains("history conflict"));
        assert_eq!(
            read(&replayed, &replay_state, "data", "value", "0")
                .value
                .as_deref(),
            Some("same")
        );
        let (same_order, _) = database(setup);
        replay(&same_order, &result.sql_statements).unwrap();
    }

    #[test]
    fn cell_edit_wide_integers_decimals_and_temporal_precision_remain_exact() {
        let setup = "CREATE TABLE data(big BIGINT, huge HUGEINT, unsigned UHUGEINT, amount DECIMAL(38,10), stamp TIMESTAMP_NS, zoned TIME WITH TIME ZONE); INSERT INTO data VALUES (9007199254740993, 170141183460469231731687303715884105726, 340282366920938463463374607431768211454, 1234567890123456789012345678.1234567890, '2025-02-03 12:34:56.123456789', '12:34:56.123456+05:30')";
        let (conn, state) = database(setup);
        assert_eq!(
            read(&conn, &state, "data", "big", "0").value.as_deref(),
            Some("9007199254740993")
        );
        assert_eq!(
            read(&conn, &state, "data", "stamp", "0").value.as_deref(),
            Some("2025-02-03 12:34:56.123456789")
        );
        assert_eq!(
            read(&conn, &state, "data", "zoned", "0").value.as_deref(),
            Some("12:34:56.123456+05:30")
        );
        for (column, value) in [
            ("big", "9223372036854775807"),
            ("huge", "170141183460469231731687303715884105727"),
            ("unsigned", "340282366920938463463374607431768211455"),
            ("amount", "9876543210987654321098765432.9876543210"),
        ] {
            let (conn, state) = database(setup);
            let edit = request(&conn, &state, "data", column, "0", Some(value));
            let result = apply_edit(&conn, &state, &edit).unwrap();
            assert_eq!(result.value.as_deref(), Some(value));
            let (replayed, replay_state) = database(setup);
            replay(&replayed, &result.sql_statements).unwrap();
            assert_eq!(
                read(&replayed, &replay_state, "data", column, "0")
                    .value
                    .as_deref(),
                Some(value)
            );
        }
    }

    #[test]
    fn cell_edit_rejects_invalid_numeric_dates_and_precision_loss_without_changes() {
        let (conn, state) = database("CREATE TABLE data(integer BIGINT, amount DECIMAL(8,2), number FLOAT, day DATE, flag BOOLEAN, uuid UUID, stamp TIMESTAMP_MS); INSERT INTO data VALUES (5, 12.34, 1, '2025-01-01', true, '550e8400-e29b-41d4-a716-446655440000', '2025-01-01 12:00:00.123')");
        for (column, value) in [
            ("integer", "1.2"),
            ("integer", "1e2"),
            ("integer", " 5 "),
            ("integer", "9223372036854775808"),
            ("amount", "12.345"),
            ("amount", "1000000.00"),
            ("number", "NaN"),
            ("number", "Infinity"),
            ("number", "1e100"),
            ("day", "2025-02-30"),
            ("day", "2025-01-01 12:00:00"),
            ("stamp", "2025-01-01 12:00:00.1234"),
            ("flag", "yes"),
            ("uuid", "invalid"),
        ] {
            let edit = request(&conn, &state, "data", column, "0", Some(value));
            let revision = state.revision();
            assert!(
                apply_edit(&conn, &state, &edit).is_err(),
                "{column}: {value}"
            );
            assert_eq!(state.revision(), revision);
            assert_eq!(
                read(&conn, &state, "data", column, "0").value,
                edit.expected_value
            );
        }
        let edit = request(&conn, &state, "data", "amount", "0", Some("+0012.3400"));
        assert_eq!(
            apply_edit(&conn, &state, &edit).unwrap().value.as_deref(),
            Some("12.34")
        );
    }

    #[test]
    fn cell_edit_bounds_values_and_rolls_back_constraints() {
        let (conn, state) = database("CREATE TABLE data(value VARCHAR NOT NULL CHECK(length(value) < 10)); INSERT INTO data VALUES ('old'); CREATE TABLE big(value VARCHAR); INSERT INTO big VALUES (repeat('é', 524289))");
        let oversized = read(&conn, &state, "big", "value", "0");
        assert!(!oversized.editable);
        assert_eq!(oversized.value, None);
        assert!(oversized.reason.unwrap().contains("1 MiB"));
        let mut edit = request(&conn, &state, "data", "value", "0", None);
        assert!(apply_edit(&conn, &state, &edit).is_err());
        edit.value = Some("violates check constraint".into());
        assert!(apply_edit(&conn, &state, &edit).is_err());
        edit.value = Some("x".repeat(MAX_CELL_EDIT_BYTES + 1));
        assert!(apply_edit(&conn, &state, &edit)
            .unwrap_err()
            .to_string()
            .contains("1 MiB"));
        assert_eq!(
            read(&conn, &state, "data", "value", "0").value.as_deref(),
            Some("old")
        );
        edit.value = Some("valid".into());
        apply_edit(&conn, &state, &edit).unwrap(); // No failed edit left a transaction open.
    }

    #[test]
    fn cell_edit_validates_schema_and_missing_row() {
        let (conn, state) =
            database("CREATE TABLE data(value VARCHAR); INSERT INTO data VALUES ('old')");
        for (table, column, rowid) in [
            ("missing", "value", "0"),
            ("data", "missing", "0"),
            ("data", "value", "999"),
            ("data", "value", "0 OR 1=1"),
            ("data", "value", "-1"),
        ] {
            assert!(read_cell(
                &conn,
                &state,
                &ReadCellValueRequest {
                    table_name: table.into(),
                    column_name: column.into(),
                    row_id: rowid.into()
                }
            )
            .is_err());
        }
        let edit = request(&conn, &state, "data", "value", "0", Some("new"));
        conn.execute_batch("DELETE FROM data").unwrap();
        assert!(apply_edit(&conn, &state, &edit)
            .unwrap_err()
            .to_string()
            .contains("no longer exists"));
    }

    #[test]
    fn cell_edit_session_close_invalidates_shared_and_reopened_targets() {
        let state = DbState::default();
        let arc = state.open_for("source").unwrap();
        arc.lock()
            .execute_batch("CREATE TABLE data(value VARCHAR); INSERT INTO data VALUES ('old')")
            .unwrap();
        state.share_for("source", "overview").unwrap();
        let edit = request(&arc.lock(), &state, "data", "value", "0", Some("new"));
        let shared = state.get("overview").unwrap();
        apply_edit(&shared.lock(), &state, &edit).unwrap();
        assert_eq!(
            read(&arc.lock(), &state, "data", "value", "0")
                .value
                .as_deref(),
            Some("new")
        );
        let edit = request(&arc.lock(), &state, "data", "value", "0", Some("next"));
        state.close_for("source");
        assert!(apply_edit(&shared.lock(), &state, &edit).is_err());
    }
}
