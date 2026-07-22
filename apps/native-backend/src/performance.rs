use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const TRACE_CAPACITY: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Trace {
    detail: String,
    duration_micros: u128,
    name: &'static str,
}

static TRACES: OnceLock<Mutex<VecDeque<Trace>>> = OnceLock::new();
static ENABLED: OnceLock<bool> = OnceLock::new();

pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| std::env::var("COMANDO_PERFORMANCE_TRACE").ok().as_deref() == Some("1"))
}

pub fn record(name: &'static str, duration: Duration, detail: impl FnOnce() -> String) {
    if !enabled() {
        return;
    }

    let mut traces = TRACES
        .get_or_init(|| Mutex::new(VecDeque::with_capacity(TRACE_CAPACITY)))
        .lock()
        .expect("performance trace lock");
    if traces.len() == TRACE_CAPACITY {
        traces.pop_front();
    }
    traces.push_back(Trace {
        detail: detail(),
        duration_micros: duration.as_micros(),
        name,
    });
}

pub fn flush_to_diagnostics() {
    if !enabled() {
        return;
    }

    let Some(traces) = TRACES.get() else {
        return;
    };
    let traces = traces.lock().expect("performance trace lock");
    for trace in traces.iter() {
        crate::logging::diagnostic(format!(
            "perf name={} durationMicros={} {}",
            trace.name, trace.duration_micros, trace.detail
        ));
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::Trace;

    #[test]
    fn trace_keeps_the_measurement_shape_compact() {
        let trace = Trace {
            detail: "command=ai_send_prompt".into(),
            duration_micros: Duration::from_millis(3).as_micros(),
            name: "sidecar.command",
        };

        assert_eq!(trace.duration_micros, 3_000);
        assert_eq!(trace.name, "sidecar.command");
    }
}
