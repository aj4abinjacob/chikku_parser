use crate::error::{AppError, AppResult};
use duckdb::core::LogicalTypeId;
use duckdb::types::{TimeUnit, Value as DuckValue, ValueRef};
use duckdb::{params, Connection};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

/// Per-window DuckDB session map. Keyed by Tauri window label.
#[derive(Default)]
pub struct DbState {
    pub sessions: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    // Global invalidation is intentionally conservative, including shared overview sessions.
    mutation_epoch: AtomicU64,
}

impl DbState {
    pub fn revision(&self) -> String {
        self.mutation_epoch.load(Ordering::SeqCst).to_string()
    }

    pub fn invalidate_cell_edits(&self) {
        self.mutation_epoch.fetch_add(1, Ordering::SeqCst);
    }

    /// Invalidate before execution: even a failed batch can already have changed data.
    pub fn exec_mutation(&self, conn: &Connection, sql: &str) -> AppResult<()> {
        self.invalidate_cell_edits();
        exec(conn, sql)
    }

    pub fn open_for(&self, label: &str) -> AppResult<Arc<Mutex<Connection>>> {
        let mut map = self.sessions.lock();
        if let Some(c) = map.get(label) {
            return Ok(c.clone());
        }
        let conn = Connection::open_in_memory()?;
        let arc = Arc::new(Mutex::new(conn));
        map.insert(label.to_string(), arc.clone());
        log::info!("DuckDB opened for window {}", label);
        Ok(arc)
    }

    pub fn close_for(&self, label: &str) {
        let mut map = self.sessions.lock();
        if map.remove(label).is_some() {
            self.invalidate_cell_edits();
            log::info!("DuckDB closed for window {}", label);
        }
    }

    pub fn share_for(&self, source_label: &str, target_label: &str) -> AppResult<()> {
        let mut map = self.sessions.lock();
        let connection = map
            .get(source_label)
            .cloned()
            .ok_or_else(|| AppError::NoDb(source_label.to_string()))?;
        map.insert(target_label.to_string(), connection);
        log::info!(
            "DuckDB session shared from window {} to {}",
            source_label,
            target_label
        );
        Ok(())
    }

    pub fn get(&self, label: &str) -> AppResult<Arc<Mutex<Connection>>> {
        let map = self.sessions.lock();
        map.get(label)
            .cloned()
            .ok_or_else(|| AppError::NoDb(label.to_string()))
    }
}

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn signed_integer_to_json(value: i64) -> Value {
    if (-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&value) {
        Value::from(value)
    } else {
        Value::from(value.to_string())
    }
}

fn unsigned_integer_to_json(value: u64) -> Value {
    if value <= JS_MAX_SAFE_INTEGER as u64 {
        Value::from(value)
    } else {
        Value::from(value.to_string())
    }
}

fn float_to_json(value: f64) -> Value {
    if value.is_nan() {
        Value::from("NaN")
    } else if value == f64::INFINITY {
        Value::from("Infinity")
    } else if value == f64::NEG_INFINITY {
        Value::from("-Infinity")
    } else {
        Value::from(value)
    }
}

fn civil_date_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_part = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_part + 2) / 5 + 1;
    let month = month_part + if month_part < 10 { 3 } else { -9 };
    if month <= 2 {
        year += 1;
    }
    (year, month as u32, day as u32)
}

fn format_year(year: i64) -> String {
    if (0..=9_999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{abs:04}", abs = year.unsigned_abs())
    } else {
        format!("+{year}")
    }
}

fn format_date(days: i64) -> String {
    let (year, month, day) = civil_date_from_days(days);
    format!("{}-{month:02}-{day:02}", format_year(year))
}

fn split_epoch_value(unit: TimeUnit, value: i64) -> (i64, u32, usize) {
    match unit {
        TimeUnit::Second => (value, 0, 0),
        TimeUnit::Millisecond => (
            value.div_euclid(1_000),
            (value.rem_euclid(1_000) * 1_000_000) as u32,
            3,
        ),
        TimeUnit::Microsecond => (
            value.div_euclid(1_000_000),
            (value.rem_euclid(1_000_000) * 1_000) as u32,
            6,
        ),
        TimeUnit::Nanosecond => (
            value.div_euclid(1_000_000_000),
            value.rem_euclid(1_000_000_000) as u32,
            9,
        ),
    }
}

fn format_time_of_day(seconds: i64, nanos: u32, precision: usize) -> String {
    let seconds_in_day = seconds.rem_euclid(86_400);
    let hour = seconds_in_day / 3_600;
    let minute = (seconds_in_day % 3_600) / 60;
    let second = seconds_in_day % 60;
    let mut formatted = format!("{hour:02}:{minute:02}:{second:02}");
    if precision > 0 {
        let divisor = 10_u32.pow(9 - precision as u32);
        formatted.push_str(&format!(".{:0precision$}", nanos / divisor));
    }
    formatted
}

fn format_timestamp(unit: TimeUnit, value: i64, has_timezone: bool) -> String {
    if value == i64::MAX {
        return "infinity".to_string();
    }
    if value == i64::MIN {
        return "-infinity".to_string();
    }
    let (seconds, nanos, precision) = split_epoch_value(unit, value);
    let days = seconds.div_euclid(86_400);
    let time = format_time_of_day(seconds, nanos, precision);
    let timezone = if has_timezone { "Z" } else { "" };
    format!("{}T{time}{timezone}", format_date(days))
}

fn format_time(unit: TimeUnit, value: i64) -> String {
    let (seconds, nanos, precision) = split_epoch_value(unit, value);
    format_time_of_day(seconds, nanos, precision)
}

fn format_blob(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 4);
    for byte in bytes {
        encoded.push_str(&format!("\\x{byte:02X}"));
    }
    encoded
}

fn duck_value_to_json(value: &DuckValue) -> Value {
    match value {
        DuckValue::Null => Value::Null,
        DuckValue::Boolean(value) => Value::Bool(*value),
        DuckValue::TinyInt(value) => Value::from(*value),
        DuckValue::SmallInt(value) => Value::from(*value),
        DuckValue::Int(value) => Value::from(*value),
        DuckValue::BigInt(value) => signed_integer_to_json(*value),
        DuckValue::HugeInt(value) => Value::from(value.to_string()),
        DuckValue::UTinyInt(value) => Value::from(*value),
        DuckValue::USmallInt(value) => Value::from(*value),
        DuckValue::UInt(value) => Value::from(*value),
        DuckValue::UBigInt(value) => unsigned_integer_to_json(*value),
        DuckValue::Float(value) => float_to_json(*value as f64),
        DuckValue::Double(value) => float_to_json(*value),
        DuckValue::Decimal(value) => Value::from(value.to_string()),
        DuckValue::Timestamp(unit, value) => Value::from(format_timestamp(*unit, *value, false)),
        DuckValue::Text(value) => Value::from(value.clone()),
        DuckValue::Blob(value) => Value::from(format_blob(value)),
        DuckValue::Date32(value) => {
            if *value == i32::MAX {
                Value::from("infinity")
            } else if *value == i32::MIN {
                Value::from("-infinity")
            } else {
                Value::from(format_date(i64::from(*value)))
            }
        }
        DuckValue::Time64(unit, value) => Value::from(format_time(*unit, *value)),
        DuckValue::Interval {
            months,
            days,
            nanos,
        } => {
            let mut object = Map::new();
            object.insert("months".into(), Value::from(*months));
            object.insert("days".into(), Value::from(*days));
            object.insert("nanos".into(), signed_integer_to_json(*nanos));
            Value::Object(object)
        }
        DuckValue::List(values) | DuckValue::Array(values) => {
            Value::Array(values.iter().map(duck_value_to_json).collect())
        }
        DuckValue::Enum(value) => Value::from(value.clone()),
        DuckValue::Struct(fields) => {
            let mut object = Map::new();
            for (key, value) in fields.iter() {
                object.insert(key.clone(), duck_value_to_json(value));
            }
            Value::Object(object)
        }
        DuckValue::Map(entries) => Value::Array(
            entries
                .iter()
                .map(|(key, value)| {
                    let mut entry = Map::new();
                    entry.insert("key".into(), duck_value_to_json(key));
                    entry.insert("value".into(), duck_value_to_json(value));
                    Value::Object(entry)
                })
                .collect(),
        ),
        DuckValue::Union(value) => duck_value_to_json(value),
    }
}

/// Convert a DuckDB row column to a JSON-safe value without losing its meaning.
fn value_ref_to_json(
    v: ValueRef<'_>,
    timestamp_has_timezone: bool,
    time_has_timezone: bool,
) -> AppResult<Value> {
    match v {
        ValueRef::Null => Ok(Value::Null),
        ValueRef::Boolean(b) => Ok(Value::Bool(b)),
        ValueRef::TinyInt(i) => Ok(Value::from(i)),
        ValueRef::SmallInt(i) => Ok(Value::from(i)),
        ValueRef::Int(i) => Ok(Value::from(i)),
        ValueRef::BigInt(i) => Ok(signed_integer_to_json(i)),
        ValueRef::HugeInt(i) => Ok(Value::from(i.to_string())),
        ValueRef::UTinyInt(i) => Ok(Value::from(i)),
        ValueRef::USmallInt(i) => Ok(Value::from(i)),
        ValueRef::UInt(i) => Ok(Value::from(i)),
        ValueRef::UBigInt(i) => Ok(unsigned_integer_to_json(i)),
        ValueRef::Float(f) => Ok(float_to_json(f as f64)),
        ValueRef::Double(f) => Ok(float_to_json(f)),
        ValueRef::Decimal(d) => Ok(Value::from(d.to_string())),
        ValueRef::Timestamp(unit, timestamp) => Ok(Value::from(format_timestamp(
            unit,
            timestamp,
            timestamp_has_timezone,
        ))),
        ValueRef::Text(bytes) => Ok(Value::from(String::from_utf8_lossy(bytes).into_owned())),
        ValueRef::Blob(bytes) => Ok(Value::from(format_blob(bytes))),
        ValueRef::Date32(days) => Ok(if days == i32::MAX {
            Value::from("infinity")
        } else if days == i32::MIN {
            Value::from("-infinity")
        } else {
            Value::from(format_date(i64::from(days)))
        }),
        ValueRef::Time64(_, _) if time_has_timezone => Err(AppError::msg(
            "TIME WITH TIME ZONE must be cast to VARCHAR before transport to preserve its offset",
        )),
        ValueRef::Time64(unit, time) => Ok(Value::from(format_time(unit, time))),
        ValueRef::Interval {
            months,
            days,
            nanos,
        } => {
            let mut m = Map::new();
            m.insert("months".into(), Value::from(months));
            m.insert("days".into(), Value::from(days));
            m.insert("nanos".into(), signed_integer_to_json(nanos));
            Ok(Value::Object(m))
        }
        ValueRef::Enum(_, _) => v
            .as_str()
            .map(|value| Value::from(value.to_string()))
            .map_err(|err| AppError::msg(format!("failed to decode ENUM value: {err}"))),
        ValueRef::List(_, _)
        | ValueRef::Struct(_, _)
        | ValueRef::Array(_, _)
        | ValueRef::Map(_, _)
        | ValueRef::Union(_, _) => Ok(duck_value_to_json(&v.to_owned())),
    }
}

fn disambiguate_column_names(names: Vec<String>) -> Vec<String> {
    let reserved: HashSet<String> = names.iter().cloned().collect();
    let mut used = HashSet::new();
    names
        .into_iter()
        .map(|name| {
            if used.insert(name.clone()) {
                return name;
            }
            let mut suffix = 1;
            loop {
                let candidate = format!("{name}_{suffix}");
                if !reserved.contains(&candidate) && used.insert(candidate.clone()) {
                    return candidate;
                }
                suffix += 1;
            }
        })
        .collect()
}

/// Run a SQL statement that returns no rows.
pub fn exec(conn: &Connection, sql: &str) -> AppResult<()> {
    conn.execute_batch(sql)?;
    Ok(())
}

/// Run a SELECT and return rows as `[{col: value, ...}, ...]`.
pub fn query(conn: &Connection, sql: &str) -> AppResult<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let mut rows = stmt.query(params![])?;
    let stmt = rows
        .as_ref()
        .ok_or_else(|| AppError::msg("query did not return statement metadata"))?;
    let col_count = stmt.column_count();
    let col_names = disambiguate_column_names(
        (0..col_count)
            .map(|i| {
                stmt.column_name(i)
                    .map(|s| s.to_string())
                    .unwrap_or_default()
            })
            .collect(),
    );
    let logical_types: Vec<LogicalTypeId> = (0..col_count)
        .map(|i| stmt.column_logical_type(i).id())
        .collect();
    let mut out: Vec<Value> = Vec::new();
    while let Some(row) = rows.next()? {
        let mut obj = Map::with_capacity(col_count);
        for i in 0..col_count {
            let v = row.get_ref(i)?;
            obj.insert(
                col_names[i].clone(),
                value_ref_to_json(
                    v,
                    logical_types[i] == LogicalTypeId::TimestampTZ,
                    logical_types[i] == LogicalTypeId::TimeTZ,
                )?,
            );
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overview_window_can_share_the_parent_session_without_copying_data() {
        let state = DbState::default();
        let source = state.open_for("main").unwrap();
        exec(
            &source.lock(),
            "CREATE TABLE active_data AS SELECT 42 AS value",
        )
        .unwrap();

        state.share_for("main", "overview-1").unwrap();
        let shared = state.get("overview-1").unwrap();
        assert!(std::sync::Arc::ptr_eq(&source, &shared));
        assert_eq!(
            query(&shared.lock(), "SELECT value FROM active_data").unwrap()[0]["value"],
            42
        );

        state.close_for("overview-1");
        assert_eq!(
            query(&source.lock(), "SELECT value FROM active_data").unwrap()[0]["value"],
            42
        );
    }

    #[test]
    fn supplied_csv_timestamp_in_filter_round_trip() {
        let conn = Connection::open_in_memory().unwrap();
        if let Ok(path) = std::env::var("CHIKKU_REPRO_CSV") {
            let escaped_path = path.replace('\'', "''");
            exec(
                &conn,
                &format!("CREATE TABLE repro AS SELECT * FROM read_csv_auto('{escaped_path}')"),
            )
            .unwrap();
        } else {
            exec(
                &conn,
                r#"CREATE TABLE repro(fetched_at TIMESTAMP WITH TIME ZONE);
                   INSERT INTO repro VALUES
                     ('2026-06-06T09:37:27.233847Z'),
                     ('2026-06-06T15:08:27.123456+05:30'),
                     ('2026-06-06T04:09:27.654321-05:30'),
                     (NULL)"#,
            )
            .unwrap();
        }

        let schema = query(&conn, "DESCRIBE repro").unwrap();
        let fetched_at_type = schema
            .iter()
            .find(|row| row["column_name"] == "fetched_at")
            .and_then(|row| row["column_type"].as_str())
            .unwrap();
        assert_eq!(fetched_at_type, "TIMESTAMP WITH TIME ZONE");

        let distinct = query(
            &conn,
            "SELECT DISTINCT fetched_at AS val FROM repro WHERE fetched_at IS NOT NULL ORDER BY fetched_at LIMIT 1",
        )
        .unwrap();
        let serialized = distinct[0]["val"].clone();
        let picker_value = serialized.as_str().unwrap().to_string();
        assert!(picker_value.ends_with('Z'));
        assert!(picker_value.contains('.'));

        let filter_sql = format!(
            "SELECT * FROM repro WHERE fetched_at IN ('{}')",
            picker_value.replace('\'', "''")
        );
        let filtered = query(&conn, &filter_sql).unwrap();
        assert_eq!(filtered.len(), 1);
    }

    #[test]
    fn timestamp_filters_accept_offsets_fractional_seconds_and_nulls() {
        let conn = Connection::open_in_memory().unwrap();
        exec(
            &conn,
            r#"CREATE TABLE timestamp_edges(value TIMESTAMP WITH TIME ZONE);
               INSERT INTO timestamp_edges VALUES
                 ('2026-06-06T09:37:27.233847Z'),
                 ('2026-06-06T15:08:28.123456+05:30'),
                 ('2026-06-06T04:09:29.654321-05:30'),
                 (NULL)"#,
        )
        .unwrap();

        let rows = query(
            &conn,
            r#"SELECT value FROM timestamp_edges
               WHERE value IN (
                 CAST('2026-06-06T09:37:27.233847Z' AS TIMESTAMP WITH TIME ZONE),
                 CAST('2026-06-06T15:08:28.123456+05:30' AS TIMESTAMP WITH TIME ZONE),
                 CAST('2026-06-06T04:09:29.654321-05:30' AS TIMESTAMP WITH TIME ZONE)
               )
               ORDER BY value"#,
        )
        .unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0]["value"], "2026-06-06T09:37:27.233847Z");
        assert_eq!(rows[1]["value"], "2026-06-06T09:38:28.123456Z");
        assert_eq!(rows[2]["value"], "2026-06-06T09:39:29.654321Z");

        let null_rows = query(
            &conn,
            "SELECT value FROM timestamp_edges WHERE value IS NULL",
        )
        .unwrap();
        assert_eq!(null_rows[0]["value"], Value::Null);
    }

    #[test]
    fn serializes_supported_values_without_silent_nulls() {
        let conn = Connection::open_in_memory().unwrap();
        exec(
            &conn,
            "CREATE TYPE audit_mood AS ENUM ('ok', 'it''s complicated')",
        )
        .unwrap();
        let rows = query(
            &conn,
            r#"SELECT
                TIMESTAMP '2026-06-06 09:37:27.233847' AS ts,
                CAST('1969-12-31 23:59:59.999999' AS TIMESTAMP) AS negative_ts,
                CAST('2026-06-06 09:37:27.123456789' AS TIMESTAMP_NS) AS nanosecond_ts,
                TIMESTAMPTZ '2026-06-06 15:07:27.233847+05:30' AS tstz,
                DATE '2026-06-06' AS date_value,
                TIME '09:37:27.233847' AS time_value,
                CAST(TIMETZ '09:37:27.233847+05:30' AS VARCHAR) AS timetz_value,
                INTERVAL '2 months 3 days 4.000005 seconds' AS interval_value,
                9007199254740993::BIGINT AS big_value,
                123456789012345678.1234567890::DECIMAL(28, 10) AS decimal_value,
                true AS bool_value,
                NULL::INTEGER AS null_value,
                ''::VARCHAR AS empty_value,
                'NaN'::DOUBLE AS nan_value,
                'Infinity'::DOUBLE AS infinity_value,
                '550e8400-e29b-41d4-a716-446655440000'::UUID AS uuid_value,
                'it''s complicated'::audit_mood AS enum_value,
                '\x00\xFF'::BLOB AS blob_value,
                '{"comma":"a,b","quote":"it''s"}'::JSON AS json_value,
                [1, NULL, 3]::INTEGER[] AS list_value,
                {'name': 'Zoë', 'ok': true} AS struct_value,
                MAP {'a': 1, 'b': 2} AS map_value"#,
        )
        .unwrap();
        let row = rows[0].as_object().unwrap();
        assert_eq!(row["ts"], "2026-06-06T09:37:27.233847");
        assert_eq!(row["negative_ts"], "1969-12-31T23:59:59.999999");
        assert_eq!(row["nanosecond_ts"], "2026-06-06T09:37:27.123456789");
        assert_eq!(row["tstz"], "2026-06-06T09:37:27.233847Z");
        assert_eq!(row["date_value"], "2026-06-06");
        assert_eq!(row["time_value"], "09:37:27.233847");
        assert_eq!(row["timetz_value"], "09:37:27.233847+05:30");
        assert_eq!(
            row["interval_value"],
            serde_json::json!({"months": 2, "days": 3, "nanos": 4_000_005_000_i64})
        );
        assert_eq!(row["big_value"], "9007199254740993");
        assert_eq!(row["decimal_value"], "123456789012345678.1234567890");
        assert_eq!(row["bool_value"], true);
        assert_eq!(row["nan_value"], "NaN");
        assert_eq!(row["infinity_value"], "Infinity");
        assert_eq!(row["enum_value"], "it's complicated");
        assert_eq!(row["uuid_value"], "550e8400-e29b-41d4-a716-446655440000");
        assert_eq!(row["blob_value"], "\\x00\\xFF");
        assert_eq!(row["json_value"], r#"{"comma":"a,b","quote":"it's"}"#);
        assert_eq!(row["empty_value"], "");
        assert_eq!(row["null_value"], Value::Null);
        assert_eq!(row["list_value"], serde_json::json!([1, null, 3]));
        assert_eq!(
            row["struct_value"],
            serde_json::json!({"name": "Zoë", "ok": true})
        );
        assert_eq!(
            row["map_value"],
            serde_json::json!([
                {"key": "a", "value": 1},
                {"key": "b", "value": 2}
            ])
        );
    }

    #[test]
    fn wide_decimal_transport_remains_exact() {
        let conn = Connection::open_in_memory().unwrap();
        let rows = query(
            &conn,
            "SELECT CAST(1234567890123456789012345678.1234567890::DECIMAL(38, 10) AS VARCHAR) AS value",
        )
        .unwrap();
        assert_eq!(rows[0]["value"], "1234567890123456789012345678.1234567890");
    }

    #[test]
    fn time_with_timezone_never_silently_loses_its_offset() {
        let conn = Connection::open_in_memory().unwrap();
        let error = query(&conn, "SELECT TIMETZ '09:37:27.233847+05:30' AS value").unwrap_err();
        assert!(error.to_string().contains("preserve its offset"));

        let rows = query(
            &conn,
            "SELECT CAST(TIMETZ '09:37:27.233847+05:30' AS VARCHAR) AS value",
        )
        .unwrap();
        assert_eq!(rows[0]["value"], "09:37:27.233847+05:30");
    }

    #[test]
    fn query_failures_are_returned_to_the_caller() {
        let conn = Connection::open_in_memory().unwrap();
        let count_error = query(&conn, "SELECT COUNT(*) FROM missing_count_table").unwrap_err();
        let chunk_error = query(&conn, "SELECT * FROM missing_chunk_table LIMIT 1000").unwrap_err();
        assert!(count_error.to_string().contains("missing_count_table"));
        assert!(chunk_error.to_string().contains("missing_chunk_table"));
    }

    #[test]
    fn duplicate_result_columns_are_disambiguated_without_data_loss() {
        let conn = Connection::open_in_memory().unwrap();
        let rows = query(&conn, "SELECT 1 AS value, 2 AS value, 3 AS value_1").unwrap();
        assert_eq!(rows[0]["value"], 1);
        assert_eq!(rows[0]["value_2"], 2);
        assert_eq!(rows[0]["value_1"], 3);
    }

    #[test]
    fn invalid_utf8_is_visible_instead_of_becoming_an_empty_string() {
        let bytes = [b'a', 0xff, b'b'];
        let value = value_ref_to_json(ValueRef::Text(&bytes), false, false).unwrap();
        assert_eq!(value, "a�b");
    }
}
