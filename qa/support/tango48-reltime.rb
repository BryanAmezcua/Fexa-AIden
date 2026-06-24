# TANGO-48 resolver — exercises the REAL Reporting::Report#relative_time for the
# new forward-looking tokens (and an unchanged backward one), emitting the
# resolved [start_date, end_date] window per token as a single JSON line.
# Day-deltas are timezone-independent, so a fresh unsaved Report (created_by nil
# -> timezone falls back to Time.zone) is sufficient. PR #6994.
require 'json'

report = Reporting::Report.new

def window(report, token)
  s, e = report.send(:relative_time, token)
  {
    token:      token,
    start_date: s&.to_date&.iso8601,
    end_date:   e&.to_date&.iso8601,
    delta_days: (s && e) ? ((e - s) / 86_400.0).round : nil,
  }
end

tokens = %w[
  next_7_days next_14_days next_30_days
  custom_days_forward_45 custom_days_forward_400 custom_days_forward_0
  past_30_days today tomorrow
]

out = {
  today:    Date.today.iso8601,
  tomorrow: Date.tomorrow.iso8601,
  results:  tokens.map { |t| window(report, t) },
}
puts 'RELTIME_JSON=' + out.to_json
