package plugin

import "testing"

func TestNormalizeStatement_SQL(t *testing.T) {
	tests := []struct {
		name   string
		system string
		in     string
		want   string
	}{
		{
			name:   "strips string literal (PII protection)",
			system: "postgresql",
			in:     "SELECT * FROM users WHERE fnr = '12345678901'",
			want:   "SELECT * FROM users WHERE fnr = ?",
		},
		{
			name:   "strips numeric literal",
			system: "postgresql",
			in:     "SELECT * FROM t WHERE id = 42",
			want:   "SELECT * FROM t WHERE id = ?",
		},
		{
			name:   "collapses IN list arity",
			system: "postgresql",
			in:     "SELECT * FROM t WHERE id IN (1, 2, 3, 4)",
			want:   "SELECT * FROM t WHERE id IN (?)",
		},
		{
			name:   "collapses VALUES list",
			system: "postgresql",
			in:     "INSERT INTO t (a,b,c) VALUES (?, ?, ?)",
			want:   "INSERT INTO t (a,b,c) VALUES (?)",
		},
		{
			name:   "canonicalizes postgres positional binds",
			system: "postgresql",
			in:     "SELECT * FROM t WHERE id = $1 AND name = $2",
			want:   "SELECT * FROM t WHERE id = ? AND name = ?",
		},
		{
			name:   "strips block comment",
			system: "postgresql",
			in:     "/* leading comment */ SELECT 1 FROM dual",
			want:   "SELECT ? FROM dual",
		},
		{
			name:   "strips line comment",
			system: "postgresql",
			in:     "SELECT * FROM t -- inline note\nWHERE id = 5",
			want:   "SELECT * FROM t WHERE id = ?",
		},
		{
			name:   "preserves hibernate table aliases (digits in identifiers)",
			system: "oracle",
			in:     "select fd1_0.id from t_fullmakt fd1_0 where fd1_0.aktor_nr in (?)",
			want:   "select fd1_0.id from t_fullmakt fd1_0 where fd1_0.aktor_nr in (?)",
		},
		{
			name:   "strips hex literal",
			system: "h2",
			in:     "SELECT * FROM t WHERE h = 0xDEADBEEF",
			want:   "SELECT * FROM t WHERE h = ?",
		},
		{
			name:   "unknown system defaults to SQL normalizer",
			system: "other_sql",
			in:     "DELETE FROM t WHERE k = 'secret'",
			want:   "DELETE FROM t WHERE k = ?",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizeStatement(tt.system, tt.in); got != tt.want {
				t.Errorf("normalizeStatement()\n got: %q\nwant: %q", got, tt.want)
			}
		})
	}
}

// SQL statements that differ only in IN-list arity must fingerprint identically;
// statements with genuinely different structure must not.
func TestNormalizeStatement_SQLGrouping(t *testing.T) {
	a := normalizeStatement("oracle", "select x from t where id in (?)")
	b := normalizeStatement("oracle", "select x from t where id in (?, ?, ?, ?, ?)")
	if a != b {
		t.Errorf("IN-arity variants should collapse equal:\n a=%q\n b=%q", a, b)
	}
	c := normalizeStatement("oracle", "select x from t where id in (?) and k in (?)")
	if a == c {
		t.Errorf("structurally different queries must not collapse: %q == %q", a, c)
	}
}

func TestNormalizeStatement_KeyValue(t *testing.T) {
	tests := []struct {
		in   string
		want string
	}{
		{"GET pdl::medFamilie:12345678901", "GET ?"},                                     // raw key dropped (PII)
		{"GET 415be5aa5916dd44f97110bfe7425eaa8ba180e32bf0d0c162e7dd2589ae07dc", "GET ?"}, // hashed key dropped
		{"PING", "PING"},
		{"set mykey myvalue", "SET ?"},
		{"HGET hash field", "HGET ?"},
	}
	for _, tt := range tests {
		if got := normalizeStatement("redis", tt.in); got != tt.want {
			t.Errorf("redis normalize %q: got %q want %q", tt.in, got, tt.want)
		}
	}
	// valkey routes through the same key-value normalizer.
	if got := normalizeStatement("valkey", "GET secret-key"); got != "GET ?" {
		t.Errorf("valkey normalize: got %q", got)
	}
}

// Redis keys must never survive normalization — the strongest PII guarantee.
func TestNormalizeStatement_KeyValueDropsArguments(t *testing.T) {
	got := normalizeStatement("redis", "GET user:profile:ola.nordmann@example.com")
	if got != "GET ?" {
		t.Fatalf("redis argument leaked into fingerprint: %q", got)
	}
}

func TestNormalizeStatement_Document(t *testing.T) {
	// $in arity varies per request; must collapse to one fingerprint.
	single := normalizeStatement("mongodb", `{"$match": {"identer": {"$in": ["?"]}}}`)
	many := normalizeStatement("mongodb", `{"$match": {"identer": {"$in": ["?", "?", "?", "?"]}}}`)
	if single != many {
		t.Errorf("mongo $in arity should collapse equal:\n single=%q\n many=%q", single, many)
	}
	// Mongo operators ($match/$project/$in) must be preserved, not stripped.
	if got := single; got != `{"$match": {"identer": {"$in": ["?"]}}}` {
		t.Errorf("mongo operators mangled: %q", got)
	}
	// Bare numeric values are still stripped.
	if got := normalizeStatement("mongodb", `{"find": "t", "limit": 100}`); got != `{"find": "t", "limit": ?}` {
		t.Errorf("mongo number strip: got %q", got)
	}
}

func TestNormalizeStatement_Empty(t *testing.T) {
	if got := normalizeStatement("postgresql", "   "); got != "" {
		t.Errorf("blank statement should normalize to empty, got %q", got)
	}
}

func TestNormalizeStatement_Truncates(t *testing.T) {
	long := "SELECT "
	for i := 0; i < 500; i++ {
		long += "col_x, "
	}
	long += "y FROM t"
	got := normalizeStatement("postgresql", long)
	if len([]rune(got)) > maxStmtOutput+1 { // +1 for the ellipsis rune
		t.Errorf("normalized statement not truncated: len=%d", len([]rune(got)))
	}
}
