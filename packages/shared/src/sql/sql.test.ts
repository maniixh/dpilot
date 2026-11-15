import { describe, expect, test } from "bun:test";
import type { Dialect } from "../data.ts";
import { classifyStatement, destructiveReasons, explainSql } from "./classify.ts";
import { redactSql } from "./redact.ts";
import { splitStatements, statementAt } from "./split.ts";
import { tokenize } from "./tokens.ts";

const texts = (sql: string, dialect: Dialect) =>
  splitStatements(sql, dialect).map((statement) => statement.text);
const code = (sql: string, dialect: Dialect) =>
  tokenize(sql, dialect)
    .filter((token) => token.kind !== "space" && token.kind !== "comment")
    .map((token) => token.text);

describe("splitStatements", () => {
  test("splits on semicolons outside quotes and comments", () => {
    const parts = splitStatements("SELECT 'a;b'; -- x;\nSELECT 2", "mysql");
    expect(parts).toHaveLength(2);
    expect(parts[0]?.text).toBe("SELECT 'a;b'");
  });

  test("keeps dollar-quoted bodies whole", () => {
    const sql = "CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT 2";
    expect(splitStatements(sql, "postgres")).toHaveLength(2);
  });

  test("honours DELIMITER", () => {
    const sql = "DELIMITER //\nCREATE PROCEDURE p() BEGIN SELECT 1; END//\nDELIMITER ;\nSELECT 2;";
    const parts = splitStatements(sql, "mysql");
    expect(parts).toHaveLength(2);
    expect(parts[0]?.text.endsWith("END")).toBe(true);
    expect(parts[1]?.text).toBe("SELECT 2");
  });

  test("honours a DELIMITER made of word characters", () => {
    const sql = "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nSELECT 2$$";
    expect(texts(sql, "mysql")).toEqual(["CREATE PROCEDURE p() BEGIN SELECT 1; END", "SELECT 2"]);
  });

  test("reports offsets into the original text", () => {
    const sql = "  SELECT 1 ;\n\n  SELECT 2  ";
    const parts = splitStatements(sql, "postgres");
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(sql.slice(part.start, part.end)).toBe(part.text);
    expect(parts[1]?.text).toBe("SELECT 2");
  });

  test("statementAt picks the statement under the cursor", () => {
    const sql = "SELECT 1; SELECT 22;   ";
    const parts = splitStatements(sql, "mysql");
    expect(statementAt(parts, 2)?.text).toBe("SELECT 1");
    expect(statementAt(parts, 14)?.text).toBe("SELECT 22");
    expect(statementAt(parts, sql.length)?.text).toBe("SELECT 22");
    expect(statementAt(parts, 0)?.text).toBe("SELECT 1");
    expect(statementAt([], 3)).toBeNull();
    expect(statementAt(splitStatements("  SELECT 1", "mysql"), 0)).toBeNull();
  });

  test("drops empty and comment-only statements", () => {
    expect(texts(";; -- nothing\n; /* c */ ;SELECT 1;;", "mysql")).toEqual(["SELECT 1"]);
  });

  test("an unterminated string swallows the rest, including later semicolons", () => {
    expect(texts("SELECT 'abc; DROP TABLE t; SELECT 2", "mysql")).toHaveLength(1);
    expect(texts("SELECT 'abc; DROP TABLE t; SELECT 2", "postgres")).toHaveLength(1);
    expect(texts("SELECT $$abc; DROP TABLE t", "postgres")).toHaveLength(1);
    expect(texts("SELECT 1 /* open; DROP TABLE t", "mysql")).toHaveLength(1);
  });

  test("does not split inside an executable comment", () => {
    expect(texts("/*!50000 SELECT 1; DROP TABLE t */; SELECT 2", "mysql")).toHaveLength(2);
  });

  test("handles MySQL # comments and Postgres nested block comments", () => {
    expect(texts("SELECT 1 # x; y\n; SELECT 2", "mysql")).toHaveLength(2);
    expect(texts("SELECT 1 # x; y\n; SELECT 2", "postgres")).toHaveLength(3);
    expect(texts("SELECT 1 /* a /* b; */ c; */; SELECT 2", "postgres")).toHaveLength(2);
    expect(texts("SELECT 1 /* a /* b; */ c; */; SELECT 2", "mysql")).toHaveLength(3);
  });
});

describe("tokenize", () => {
  test("handles E'' strings, MySQL backslash escapes and doubled quotes", () => {
    expect(code("SELECT E'\\'; DROP'; SELECT 2", "postgres")).toEqual([
      "SELECT",
      "E'\\'; DROP'",
      ";",
      "SELECT",
      "2",
    ]);
    expect(code("SELECT 'it\\'s; x'", "mysql")).toEqual(["SELECT", "'it\\'s; x'"]);
    expect(code("SELECT 'it''s; x'", "postgres")).toEqual(["SELECT", "'it''s; x'"]);
    expect(code("SELECT 'a\\'; DROP TABLE t", "postgres")).toEqual([
      "SELECT",
      "'a\\'",
      ";",
      "DROP",
      "TABLE",
      "t",
    ]);
  });

  test("treats double quotes as identifiers on Postgres and strings on MySQL", () => {
    expect(tokenize('"a"', "postgres")[0]?.kind).toBe("ident");
    expect(tokenize('"a"', "mysql")[0]?.kind).toBe("string");
    expect(tokenize("`a`", "mysql")[0]?.kind).toBe("ident");
    expect(tokenize('"a""b;"', "postgres")).toHaveLength(1);
  });

  test("handles tagged dollar quotes", () => {
    const sql = "SELECT $tag$ a $$ ; $tag$, $1";
    expect(code(sql, "postgres")).toEqual(["SELECT", "$tag$ a $$ ; $tag$", ",", "$1"]);
    expect(tokenize("a$b$c", "postgres")).toHaveLength(1);
  });

  test("an unterminated string or comment runs to the end of the text", () => {
    const strings = tokenize("SELECT 'a; DROP", "mysql");
    expect(strings[strings.length - 1]?.kind).toBe("string");
    expect(strings).toHaveLength(3);
    const comment = tokenize("SELECT /* a; DROP", "postgres");
    expect(comment[comment.length - 1]?.kind).toBe("comment");
  });

  test("MySQL -- is a comment only before whitespace", () => {
    expect(code("SELECT 1--1", "mysql")).toEqual(["SELECT", "1", "-", "-", "1"]);
    expect(code("SELECT 1-- x", "mysql")).toEqual(["SELECT", "1"]);
    expect(code("SELECT 1--1", "postgres")).toEqual(["SELECT", "1"]);
  });

  test("keeps Unicode identifiers together and offsets exact", () => {
    const sql = "SELECT `näme`, ünï, 😀 FROM t";
    for (const dialect of ["mysql", "postgres"] as const) {
      const tokens = tokenize(sql, dialect);
      expect(tokens.map((token) => token.text).join("")).toBe(sql);
      for (const token of tokens) expect(sql.slice(token.start, token.end)).toBe(token.text);
    }
    expect(code(sql, "mysql")).toEqual(["SELECT", "`näme`", ",", "ünï", ",", "😀", "FROM", "t"]);
  });

  test("executable comments are tokenized as code", () => {
    expect(code("/*!50000 DROP TABLE t */", "mysql")).toEqual(["DROP", "TABLE", "t"]);
    expect(code("/*M! DROP TABLE t */", "mysql")).toEqual(["DROP", "TABLE", "t"]);
    expect(code("/*!DROP TABLE t*/", "mysql")).toEqual(["DROP", "TABLE", "t"]);
    expect(code("/*!50000 DROP TABLE t */", "postgres")).toEqual([]);
  });
});

describe("classifyStatement", () => {
  test("classifies a data-modifying CTE as write", () => {
    const sql = "WITH g AS (DELETE FROM t RETURNING *) SELECT * FROM g";
    expect(classifyStatement(sql, "postgres")).not.toBe("read");
    expect(destructiveReasons(sql, "postgres")).toContain("DELETE without WHERE affects every row");
  });

  test("treats executable comments as code", () => {
    expect(classifyStatement("/*!50000 DROP TABLE t */", "mysql")).toBe("ddl");
    expect(destructiveReasons("/*!50000 DROP TABLE t */", "mysql")).toContain("Drops table");
    expect(classifyStatement("/* DROP TABLE t */ SELECT 1", "mysql")).toBe("read");
    expect(destructiveReasons("/* DROP TABLE t */ SELECT 1", "mysql")).toEqual([]);
    expect(classifyStatement("/*M! DROP TABLE t */", "mysql")).toBe("ddl");
  });

  test("classifies INTO OUTFILE as unknown", () => {
    expect(classifyStatement("SELECT * FROM t INTO OUTFILE '/tmp/x'", "mysql")).toBe("unknown");
    expect(classifyStatement("SELECT * FROM t INTO DUMPFILE '/tmp/x'", "mysql")).toBe("unknown");
    expect(classifyStatement("SELECT * INTO copy FROM t", "postgres")).not.toBe("read");
    expect(classifyStatement("SELECT a INTO @v FROM t", "mysql")).toBe("unknown");
    expect(classifyStatement("SELECT * FROM t FOR UPDATE", "mysql")).not.toBe("read");
    expect(classifyStatement("SELECT * FROM t FOR SHARE", "postgres")).not.toBe("read");
    expect(classifyStatement("SELECT * FROM t FOR NO KEY UPDATE", "postgres")).not.toBe("read");
    expect(classifyStatement("SELECT * FROM t LOCK IN SHARE MODE", "mysql")).not.toBe("read");
    expect(classifyStatement("EXPLAIN ANALYZE DELETE FROM t", "postgres")).not.toBe("read");
    expect(classifyStatement("EXPLAIN ANALYZE SELECT 1", "mysql")).not.toBe("read");
    expect(classifyStatement("EXPLAIN (ANALYZE, BUFFERS) SELECT 1", "postgres")).not.toBe("read");
    expect(classifyStatement("EXPLAIN ANALYSE SELECT 1", "postgres")).not.toBe("read");
  });

  test("reads", () => {
    const reads = [
      "SELECT 1",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "SHOW TABLES",
      "SHOW CREATE TABLE t",
      "EXPLAIN SELECT 1",
      "VALUES (1)",
      "TABLE t",
      "DESCRIBE t",
      "DESC t",
      "(SELECT 1) UNION (SELECT 2)",
      "select nextval('s')",
      "SELECT REPLACE(a, 'x', 'y') FROM t",
      "SELECT 'DELETE FROM t; DROP TABLE t' AS s, \"update\" FROM t",
    ];
    for (const sql of reads) {
      expect([sql, classifyStatement(sql, "postgres")]).toEqual([sql, "read"]);
    }
    expect(classifyStatement("SELECT INSERT('abc', 1, 1, 'x')", "mysql")).toBe("read");
    expect(classifyStatement("SELECT `delete` FROM `into`", "mysql")).toBe("read");
    expect(classifyStatement("SELECT 1; -- trailing", "mysql")).toBe("read");
  });

  test("classifies other statement families", () => {
    expect(classifyStatement("BEGIN", "postgres")).toBe("transaction");
    expect(classifyStatement("COMMIT", "mysql")).toBe("transaction");
    expect(classifyStatement("ROLLBACK", "mysql")).toBe("transaction");
    expect(classifyStatement("START TRANSACTION READ WRITE", "mysql")).toBe("transaction");
    expect(classifyStatement("SET x = 1", "mysql")).toBe("session");
    expect(classifyStatement("USE db", "mysql")).toBe("session");
    expect(classifyStatement("INSERT INTO t VALUES (1)", "mysql")).toBe("write");
    expect(classifyStatement("REPLACE INTO t VALUES (1)", "mysql")).toBe("write");
    expect(classifyStatement("INSERT INTO t SELECT * FROM u", "postgres")).toBe("write");
    expect(classifyStatement("UPDATE t SET a = 1 WHERE b = 2", "postgres")).toBe("write");
    expect(classifyStatement("DELETE FROM t", "mysql")).toBe("write");
    const merge = "MERGE INTO t USING u ON true WHEN MATCHED THEN DELETE";
    expect(classifyStatement(merge, "postgres")).toBe("write");
    expect(classifyStatement("CREATE TABLE t (a int)", "mysql")).toBe("ddl");
    expect(classifyStatement("ALTER TABLE t ADD c int", "postgres")).toBe("ddl");
    expect(classifyStatement("TRUNCATE t", "postgres")).toBe("ddl");
    expect(classifyStatement("GRANT ALL ON *.* TO u", "mysql")).toBe("ddl");
  });

  test("anything it cannot place is unknown", () => {
    const unknowns = [
      "CALL p()",
      "DO 1",
      "DO $$ BEGIN PERFORM 1; END $$",
      "LOAD DATA INFILE '/tmp/x' INTO TABLE t",
      "HANDLER t OPEN",
      "LOCK TABLES t WRITE",
      "COPY t TO '/tmp/x'",
      "START REPLICA",
      "",
      "-- only a comment",
    ];
    for (const sql of unknowns) {
      expect([sql, classifyStatement(sql, "mysql")]).toEqual([sql, "unknown"]);
      expect([sql, classifyStatement(sql, "postgres")]).toEqual([sql, "unknown"]);
    }
  });

  test("text with a second statement is never read", () => {
    expect(classifyStatement("SELECT 1; DROP TABLE t", "mysql")).toBe("unknown");
    expect(classifyStatement("SELECT 1; SELECT 2", "postgres")).toBe("unknown");
    expect(classifyStatement("/*!50000 SELECT 1; DROP TABLE t */", "mysql")).toBe("unknown");
    expect(destructiveReasons("SELECT 1; DROP TABLE t", "mysql")).toContain("Drops table");
  });

  test("an unterminated string hides nothing and reveals nothing", () => {
    expect(classifyStatement("SELECT 'abc; DROP TABLE t", "mysql")).toBe("read");
    expect(destructiveReasons("SELECT 'abc; DROP TABLE t", "mysql")).toEqual([]);
    expect(classifyStatement("SELECT 'a\\'; DROP TABLE t", "postgres")).toBe("unknown");
  });

  test("Postgres E'' strings and MySQL backslashes do not leak words", () => {
    expect(classifyStatement("SELECT E'\\'' ; DROP TABLE t", "postgres")).toBe("unknown");
    expect(classifyStatement("SELECT E'\\' DELETE'", "postgres")).toBe("read");
    expect(classifyStatement("SELECT 'a\\' DELETE'", "mysql")).toBe("read");
    expect(classifyStatement("SELECT $x$ DELETE $x$", "postgres")).toBe("read");
  });

  test("non-ASCII look-alikes are not mistaken for keywords", () => {
    expect(classifyStatement("SELECT\u00a01", "mysql")).toBe("unknown");
    expect(classifyStatement("ＳＥＬＥＣＴ 1", "mysql")).toBe("unknown");
  });
});

describe("destructiveReasons", () => {
  test("flags DELETE and UPDATE without WHERE", () => {
    expect(destructiveReasons("DELETE FROM t", "mysql")).toEqual([
      "DELETE without WHERE affects every row",
    ]);
    expect(destructiveReasons("UPDATE t SET a = (SELECT 1 WHERE true)", "postgres")).toEqual([
      "UPDATE without WHERE affects every row",
    ]);
    expect(destructiveReasons("DELETE FROM t WHERE id = 1", "mysql")).toEqual([]);
    expect(destructiveReasons("UPDATE t SET a = (SELECT 1) WHERE b IN (1)", "mysql")).toEqual([]);
    expect(destructiveReasons("TRUNCATE t", "postgres")).toEqual(["Empties the table (TRUNCATE)"]);
    expect(destructiveReasons("ALTER TABLE t DROP COLUMN c", "mysql")).toEqual([
      "Drops part of a table (ALTER … DROP)",
    ]);
    expect(destructiveReasons("SELECT 'DROP TABLE'", "mysql")).toEqual([]);
    expect(destructiveReasons("-- DROP TABLE t\nSELECT 1", "mysql")).toEqual([]);
  });

  test("names the object kind being dropped", () => {
    expect(destructiveReasons("DROP DATABASE d", "mysql")).toEqual(["Drops database"]);
    expect(destructiveReasons("DROP TEMPORARY TABLE IF EXISTS t", "mysql")).toEqual([
      "Drops table",
    ]);
    expect(destructiveReasons("DROP MATERIALIZED VIEW v", "postgres")).toEqual([
      "Drops materialized view",
    ]);
    expect(destructiveReasons("DROP", "mysql")).toEqual(["Drops object"]);
  });

  test("a WHERE only counts at the statement's own parenthesis level", () => {
    const cte = "WITH g AS (DELETE FROM t RETURNING *) SELECT * FROM g WHERE x";
    expect(destructiveReasons(cte, "postgres")).toEqual(["DELETE without WHERE affects every row"]);
    const guarded = "WITH g AS (DELETE FROM t WHERE a = 1 RETURNING *) SELECT * FROM g";
    expect(destructiveReasons(guarded, "postgres")).toEqual([]);
    expect(destructiveReasons("DELETE FROM t WHERE a IN (SELECT 1)", "mysql")).toEqual([]);
  });

  test("does not mistake clauses of other statements for DELETE or UPDATE", () => {
    const clauses = [
      "CREATE TABLE c (a int REFERENCES p ON DELETE CASCADE ON UPDATE CASCADE)",
      "INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2",
      "INSERT INTO t VALUES (1) ON CONFLICT (a) DO UPDATE SET b = 1",
      "SELECT * FROM t FOR UPDATE",
      "SELECT * FROM t FOR NO KEY UPDATE",
      "GRANT UPDATE, DELETE ON t TO u",
      "CREATE TRIGGER x BEFORE INSERT OR UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f()",
      "ALTER TABLE t ADD FOREIGN KEY (a) REFERENCES p ON DELETE SET NULL",
    ];
    for (const sql of clauses) {
      expect([sql, destructiveReasons(sql, "postgres")]).toEqual([sql, []]);
    }
  });

  test("a statement that cannot be placed but mentions a risky word asks", () => {
    const ask = ["Can't tell what this statement changes"];
    const analyze = "EXPLAIN ANALYZE DELETE FROM t WHERE id = 1";
    expect(destructiveReasons(analyze, "mysql")).toEqual(ask);
    expect(destructiveReasons("DO $$ BEGIN DELETE FROM t; END $$", "postgres")).toEqual(ask);
    expect(destructiveReasons("PREPARE s FROM 'DROP TABLE t'", "mysql")).toEqual(ask);
    expect(destructiveReasons("CALL p()", "mysql")).toEqual([]);
    expect(destructiveReasons("SELECT 1 FROM t INTO OUTFILE 'drop'", "mysql")).toEqual(ask);
  });

  test("is empty for harmless statements", () => {
    for (const sql of ["SELECT 1", "INSERT INTO t VALUES (1)", "CREATE TABLE t (a int)", ""]) {
      expect(destructiveReasons(sql, "mysql")).toEqual([]);
    }
  });
});

describe("redactSql", () => {
  test("redacts passwords", () => {
    const user = redactSql("CREATE USER u IDENTIFIED BY 'secret'");
    expect(user).toContain("'***'");
    expect(user).not.toContain("secret");
    expect(redactSql("ALTER ROLE u PASSWORD 'x'")).toBe("ALTER ROLE u PASSWORD '***'");
    expect(redactSql("ALTER ROLE u WITH ENCRYPTED PASSWORD $$p w$$ LOGIN")).toBe(
      "ALTER ROLE u WITH ENCRYPTED PASSWORD '***' LOGIN",
    );
  });

  test("redacts every variant that carries a secret", () => {
    const cases: [string, string][] = [
      [
        "CREATE USER a IDENTIFIED BY 'one', b IDENTIFIED BY \"two\"",
        "CREATE USER a IDENTIFIED BY '***', b IDENTIFIED BY '***'",
      ],
      [
        "CREATE USER u IDENTIFIED WITH mysql_native_password BY 'pw'",
        "CREATE USER u IDENTIFIED WITH mysql_native_password BY '***'",
      ],
      [
        "ALTER USER u IDENTIFIED BY 'new' REPLACE 'old'",
        "ALTER USER u IDENTIFIED BY '***' REPLACE '***'",
      ],
      ["SET PASSWORD = PASSWORD('pw')", "SET PASSWORD = PASSWORD('***')"],
      ["SET PASSWORD FOR 'u'@'h' = 'pw'", "SET PASSWORD FOR 'u'@'h' = '***'"],
      ["CHANGE MASTER TO MASTER_PASSWORD = 'pw'", "CHANGE MASTER TO MASTER_PASSWORD = '***'"],
      ["CREATE USER u IDENTIFIED BY 'it\\'s'", "CREATE USER u IDENTIFIED BY '***'"],
      ["create user u identified by 'unterminated", "create user u identified by '***'"],
    ];
    for (const [input, expected] of cases) expect(redactSql(input)).toBe(expected);
  });

  test("leaves other strings alone", () => {
    const sql = "SELECT 'password', 'identified by' FROM t WHERE a = 'x'";
    expect(redactSql(sql)).toBe(sql);
    expect(redactSql("CREATE USER u IDENTIFIED BY RANDOM PASSWORD")).toBe(
      "CREATE USER u IDENTIFIED BY RANDOM PASSWORD",
    );
  });
});

describe("explainSql", () => {
  test("never analyzes", () => {
    expect(explainSql("mysql", "SELECT 1")).toBe("EXPLAIN SELECT 1");
    expect(explainSql("postgres", "SELECT 1")).toBe("EXPLAIN (FORMAT TEXT) SELECT 1");
  });
});
