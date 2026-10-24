# HARNESS g3: runcase <ma> <lệnh...> — chạy, bắt exit NGAY, lưu output (che DSN) vào out/<ma>.txt, ghi cases.tsv
G3=evidence/itacc_r10/g3
H="python $G3/harness/run.py"
Q="python $G3/harness/q.py"
runcase() {
  local ma=$1; shift
  local out=$G3/out/$ma.txt
  "$@" > "$out.tmp" 2>&1; local rc=$?
  sed -E 's#(postgres(ql)?://[^:]+:)[^@]+@#\1***@#g' "$out.tmp" > "$out"; rm -f "$out.tmp"
  echo "[exit=$rc]" >> "$out"
  printf '%s\t%s\t%s\t%s\n' "$ma" "$rc" "$(date -Iseconds)" "$*" >> $G3/cases.tsv
  echo "== [$ma] exit=$rc"; tail -n ${TAILN:-30} "$out"
}
SW=C:/Users/hahuy/AppData/Local/Temp/claude/D--code-samsam/86c80dd1-dfb9-4a98-ba2d-8954bd0353d0/scratchpad/r10/g3
