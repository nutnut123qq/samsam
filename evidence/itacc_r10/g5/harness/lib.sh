# Harness g5 — hàm chạy 1 ca: source env khối (DSN DB thử, KHÔNG in), chạy lệnh,
# bắt exit NGAY, che DSN, ghi evidence/itacc_r10/g5/runs/<ca>.txt.
# Dùng: source lib.sh; run_case <ma_ca> <farm|dp> <lệnh...>
S="C:/Users/hahuy/AppData/Local/Temp/claude/D--code-samsam/86c80dd1-dfb9-4a98-ba2d-8954bd0353d0/scratchpad/r10"
G5="$S/g5"
REPO=/d/code/samsam
EV="$REPO/evidence/itacc_r10/g5/runs"
H="$REPO/evidence/itacc_r10/g5/harness"
mkdir -p "$EV" "$G5"
export PYTHONIOENCODING=utf-8
_mask() { sed -E 's#(postgres(ql)?://[^:/@]+:)[^@]+@#\1***@#g; s#sk-or-[A-Za-z0-9_-]+#sk-or-***#g'; }
run_case() {
  local id="$1" envn="$2"; shift 2
  source "$S/secret/env_samsam_itacc_r10_${envn}.sh"
  cd "$REPO" || return 99
  local out rc
  out=$("$@" 2>&1); rc=$?
  { echo "# ca: $id"; echo "# env: DB thử khối $envn (DSN che)"; echo "# cmd: $*";
    echo "# exit: $rc"; echo "# thoi_gian: $(date '+%Y-%m-%dT%H:%M:%S%z')"; echo "$out"; } | _mask > "$EV/$id.txt"
  echo "[$id] exit=$rc"; tail -n "${TAILN:-12}" "$EV/$id.txt" | cut -c1-300
  return $rc
}
# SQL nhanh trên DB thử (owner) — in kết quả
q() { local envn="$1"; shift; source "$S/secret/env_samsam_itacc_r10_${envn}.sh"; cd "$REPO" && python "$H/q.py" "$@"; }
