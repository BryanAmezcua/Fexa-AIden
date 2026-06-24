# TANGO-51 resolver — verifies the GL-code nil-vs-'' contract that stops a
# removed invoice GL code from being re-derived on save (commit 59189fe1fd).
#
# Runs entirely inside a transaction that ROLLS BACK, so no demo data is mutated.
# On a real SubcontractorInvoice + its assignment, with the WO aligned to the one
# GL mapping (category_id=3, workorder_class_id=2 -> "531103"), it proves both
# re-derivation paths honor the contract:
#   - maybe_set_gl_code (the model guard): an explicit clear ('' non-nil) after a
#     saved change is NOT re-derived.
#   - SetGlCodesJob (the async path): gl_code=nil DERIVES the mapped code, while a
#     cleared '' is SKIPPED (TANGO-51 line: `next if !gl_code.nil? && gl_code.blank?`).
require 'json'

SI = Invoices::SubcontractorInvoice
out = {}

ActiveRecord::Base.transaction do
  inv = SI.all.detect { |i| (i.workorder_assignment.present? && i.workorders.any?) rescue false }
  raise 'TANGO-51: no SubcontractorInvoice with an assignment + workorder found' unless inv
  asn = inv.workorder_assignment
  wo  = inv.workorders.first
  out[:invoice_id] = inv.id
  out[:assignment_id] = asn.id
  out[:wo_id] = wo.id

  criteria = { category_id: 3, workorder_class_id: 2 }
  # The one demo GL mapping (category 3 / class 2 -> 531103) confirms a real code exists;
  # the job derivation below is driven via the assignment's manual gl_code so the test
  # doesn't depend on the finicky PermutationRankable criteria shape of get_first_match.
  out[:mapping_code] = Accounting::GlMapping.get_first_match(criteria.merge(account_type: 'expense'))&.gl_code
  SOURCE_CODE = '531103'

  # --- model guard: maybe_set_gl_code leaves an explicit '' clear alone ---
  inv.update_columns(gl_code: '')
  inv.define_singleton_method(:saved_change_to_gl_code?) { true }
  inv.send(:maybe_set_gl_code)
  inv.reload
  out[:guard_blank_stays] = inv.gl_code            # expect ''

  inv.update_columns(gl_code: nil)
  inv.define_singleton_method(:saved_change_to_gl_code?) { true }
  out[:guard_nil_no_raise] = (inv.send(:maybe_set_gl_code); true) rescue false

  # --- SetGlCodesJob: a nil invoice receives the code; a cleared '' is skipped ---
  # Drive the job's @gl_code via the assignment's manual code (set_gl_code line 63),
  # so it has a real value to apply regardless of get_first_match matching.
  asn.update_columns(gl_code: SOURCE_CODE, gl_code_set_manually: true) rescue nil
  inv.update_columns(prevent_update_from_assignment: false) rescue nil
  out[:invoice_in_approved_state] = (inv.in_approved_state? rescue nil)

  # Reload the assignment before each run so the job reads current DB state via a
  # fresh subcontractor_invoices association (in the real flow it runs in a fresh
  # Sidekiq process) — otherwise a cached invoice instance masks the update.
  inv.update_columns(gl_code: nil)
  SetGlCodesJob.new.perform(asn.reload, criteria, 'expense')
  inv.reload
  out[:job_from_nil] = inv.gl_code                 # expect SOURCE_CODE (received)

  inv.update_columns(gl_code: '')
  SetGlCodesJob.new.perform(asn.reload, criteria, 'expense')
  inv.reload
  out[:job_from_blank] = inv.gl_code               # expect '' (skipped — the fix)

  out[:source_code] = SOURCE_CODE
  raise ActiveRecord::Rollback
end

puts 'T51_JSON=' + out.to_json
