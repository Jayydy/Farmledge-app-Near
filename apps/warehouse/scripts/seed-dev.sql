-- Demo records for running the warehouse app locally against a `test`
-- database: one warehouse, a custodian (sign in as 0800 000 0001), a
-- verifier and one registered farmer (0803 123 4567). Safe to re-run.
-- Then set the custodian's PIN:
--   echo 482915 | npm run set-pin -- --phone=+2348000000001   (from the repo root)

INSERT INTO warehouses (id, code, name, state, lga)
VALUES ('6f1f2c3e-0000-4000-8000-000000000001', 'KN-DEMO', 'Dawanau Demo Store', 'Kano', 'Dala')
ON CONFLICT (id) DO NOTHING;

INSERT INTO custodians (id, warehouse_id, full_name, phone)
VALUES ('6f1f2c3e-0000-4000-8000-000000000002', '6f1f2c3e-0000-4000-8000-000000000001',
        'Amina Sani', '+2348000000001')
ON CONFLICT (id) DO NOTHING;

INSERT INTO verifiers (id, full_name, phone)
VALUES ('6f1f2c3e-0000-4000-8000-000000000003', 'Bala Musa', '+2348000000003')
ON CONFLICT (id) DO NOTHING;

-- Verifiers act only at warehouses they are assigned to (docs/decisions.md D44).
INSERT INTO verifier_warehouses (verifier_id, warehouse_id)
VALUES ('6f1f2c3e-0000-4000-8000-000000000003', '6f1f2c3e-0000-4000-8000-000000000001')
ON CONFLICT (verifier_id, warehouse_id) DO NOTHING;

INSERT INTO farmers (id, full_name, phone, lookup_consent, consent_given_at, data_consent_at)
VALUES ('6f1f2c3e-0000-4000-8000-000000000004', 'Musa Bello', '+2348031234567', false, NULL, now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO farmer_warehouses (farmer_id, warehouse_id, registered_by)
VALUES ('6f1f2c3e-0000-4000-8000-000000000004', '6f1f2c3e-0000-4000-8000-000000000001',
        '6f1f2c3e-0000-4000-8000-000000000002')
ON CONFLICT (farmer_id, warehouse_id) DO NOTHING;
