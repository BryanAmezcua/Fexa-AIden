# TANGO-60 resolver — verifies the deterministic backend behavior of "Support
# Non Enforced Pricings" against the REAL pricing model, emitting one JSON line.
#
#  - enforces_rate? matrix: the lock gate. Only an enforced Flat Rate + base_price>0
#    locks the field; Decrease/Increase (even with the flag) and non-enforced Flat
#    stay editable. This is exactly the gate get_unit_price uses for
#    prevent_price_modification, so it proves "enforced locks / non-enforced &
#    Decrease/Increase stay editable".
#  - evaluate_data per pricing type: each non-enforced type computes a real
#    Approved Rate reference (Flat = base; Increase = unit_price + delta;
#    Decrease = unit_price − delta), proving a Decrease surfaces a usable rate
#    (the value the TANGO-60 display-only fallback now feeds to approved_rate).
#
# Reuses the approved-rate-reference fixtures (Flat/Increase/Decrease editable
# pricings on one product). Run seed:approved-rate-reference first.
require 'json'

SPP = Products::SubcontractorProductPricing

decrease = SPP.find_by('name LIKE ?', 'Approved Rate Ref - Decrease%')
flat     = SPP.find_by('name LIKE ?', 'Approved Rate Ref - Flat Rate%')
increase = SPP.find_by('name LIKE ?', 'Approved Rate Ref - Increase%')
raise 'TANGO-60: approved-rate-reference fixtures missing (run seed:approved-rate-reference)' unless decrease && flat && increase

def enforces(type, base, prevent)
  SPP.new(pricing_type: type, base_price: base, prevent_price_modification: prevent).enforces_rate?
end

UNIT_PRICE = 100.0
def approved(pricing, unit_price)
  opts = {
    product_id: pricing.product_id, role_id: pricing.role_id,
    workorder_class_id: 0, department_id: 0, category_id: 0,
    facility_id: [], city: [], state: [], district_id: [], region_id: [],
    comparison_date: Date.current, unit_price: unit_price,
  }
  (Products::SubcontractorProductPricing.evaluate_data(opts, pricing).to_f rescue nil)
end

def card(p, unit_price)
  { pricing_type: p.pricing_type, base_price: p.base_price.to_f,
    prevent_flag: !!p.prevent_price_modification, enforces_rate: p.enforces_rate?,
    approved_rate: approved(p, unit_price) }
end

out = {
  unit_price: UNIT_PRICE,
  enforces_rate_matrix: {
    enforced_flat_rate: enforces('Flat Rate', 100, true),   # expect true  (LOCKED)
    nonenforced_flat:   enforces('Flat Rate', 100, false),  # expect false (editable)
    decrease_with_flag: enforces('Decrease', 15, true),     # expect false (editable — grandfathered)
    increase_with_flag: enforces('Increase', 25, true),     # expect false (editable)
  },
  decrease: card(decrease, UNIT_PRICE),
  increase: card(increase, UNIT_PRICE),
  flat:     card(flat, UNIT_PRICE),
}
puts 'PRICING_JSON=' + out.to_json
