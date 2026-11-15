import { describe, expect, test } from "bun:test";
import type { SavedConnection } from "@dpilot/shared";
import {
  emptyForm,
  fromSaved,
  invalidFields,
  needsPassword,
  switchEngine,
  toInput,
  toPatch,
} from "./form-model.ts";

const saved: SavedConnection = {
  id: "0b5f0a52-6a7e-4c64-9d39-0d7f5c3c1a11",
  label: "Staging",
  engine: "postgres",
  host: "db.example.com",
  port: 5432,
  username: "app",
  database: "app",
  tls: { mode: "require", ca: null },
  readOnly: false,
  hasPassword: true,
  passwordLost: false,
  createdAt: "2026-11-15T00:00:00.000Z",
  updatedAt: "2026-11-15T00:00:00.000Z",
};

const PEM = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";

describe("form model", () => {
  test("emptyForm uses the engine's port and user", () => {
    expect(emptyForm("postgres")).toMatchObject({
      engine: "postgres",
      host: "127.0.0.1",
      port: "5432",
      username: "postgres",
      password: "",
      database: "",
      tlsMode: "off",
      ca: "",
    });
  });

  test("switchEngine replaces the defaults the user left alone", () => {
    expect(switchEngine(emptyForm("mysql"), "postgres")).toMatchObject({
      engine: "postgres",
      port: "5432",
      username: "postgres",
    });
  });

  test("switchEngine keeps a port the user typed", () => {
    const typed = { ...emptyForm("mysql"), port: "3307", username: "admin" };
    expect(switchEngine(typed, "postgres")).toMatchObject({
      engine: "postgres",
      port: "3307",
      username: "admin",
    });
  });

  test("toInput turns blanks into null", () => {
    const input = toInput({ ...emptyForm("mysql"), label: "Local" });
    expect(input).toEqual({
      label: "Local",
      engine: "mysql",
      host: "127.0.0.1",
      port: 3306,
      username: "root",
      password: null,
      database: null,
      tls: { mode: "off", ca: null },
    });
  });

  test("toInput drops the CA unless verifying", () => {
    const values = { ...emptyForm("mysql"), label: "Local", ca: PEM };
    expect(toInput({ ...values, tlsMode: "require" }).tls).toEqual({ mode: "require", ca: null });
    expect(toInput({ ...values, tlsMode: "verify" }).tls).toEqual({ mode: "verify", ca: PEM });
  });

  test("fromSaved leaves the password empty", () => {
    expect(fromSaved(saved)).toMatchObject({ port: "5432", password: "", tlsMode: "require" });
  });

  test("toPatch sends only the changed fields", () => {
    expect(toPatch({ ...fromSaved(saved), label: "Prod", port: "6543" }, saved)).toEqual({
      label: "Prod",
      port: 6543,
    });
  });

  test("toPatch omits a blank password", () => {
    expect(toPatch(fromSaved(saved), saved)).toEqual({});
    expect(toPatch({ ...fromSaved(saved), password: "new" }, saved)).toEqual({ password: "new" });
  });

  test("toPatch clears the default database when emptied", () => {
    expect(toPatch({ ...fromSaved(saved), database: "" }, saved)).toEqual({ database: null });
  });

  test("needsPassword when the host changes and the password is blank", () => {
    expect(needsPassword({ ...fromSaved(saved), host: "127.0.0.2" }, saved)).toBe(true);
    expect(needsPassword({ ...fromSaved(saved), host: "127.0.0.2", password: "x" }, saved)).toBe(
      false,
    );
  });

  test("no password needed for a label-only change", () => {
    expect(needsPassword({ ...fromSaved(saved), label: "Prod" }, saved)).toBe(false);
  });

  test("no password needed when none was saved", () => {
    const open = { ...saved, hasPassword: false };
    expect(needsPassword({ ...fromSaved(open), host: "127.0.0.2" }, open)).toBe(false);
  });

  test("removing the saved password sends null and needs no new one", () => {
    const values = { ...fromSaved(saved), host: "127.0.0.2", clearPassword: true };
    expect(toPatch(values, saved)).toEqual({ host: "127.0.0.2", password: null });
    expect(needsPassword(values, saved)).toBe(false);
  });

  test("a typed password wins over removing it", () => {
    const values = { ...fromSaved(saved), password: "new", clearPassword: true };
    expect(toPatch(values, saved)).toEqual({ password: "new" });
  });

  test("invalidFields is empty for a valid form", () => {
    expect(invalidFields({ ...emptyForm("mysql"), label: "Local" }, null).size).toBe(0);
    expect(invalidFields(fromSaved(saved), saved).size).toBe(0);
  });

  test("invalidFields flags a blank label and a bad port", () => {
    expect([...invalidFields({ ...emptyForm("mysql"), port: "70000" }, null)].sort()).toEqual([
      "label",
      "port",
    ]);
  });

  test("invalidFields flags a CA that isn't PEM when verifying", () => {
    const values = { ...emptyForm("mysql"), label: "Local", tlsMode: "verify" as const, ca: "x" };
    expect([...invalidFields(values, null)]).toEqual(["ca"]);
  });

  test("invalidFields checks only changed fields when editing", () => {
    expect([...invalidFields({ ...fromSaved(saved), host: "bad host" }, saved)]).toEqual(["host"]);
  });
});
