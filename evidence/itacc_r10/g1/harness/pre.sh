# usage: source pre.sh ceo|intel
S=/c/Users/hahuy/AppData/Local/Temp/claude/D--code-samsam/86c80dd1-dfb9-4a98-ba2d-8954bd0353d0/scratchpad/r10
G=$S/g1
EV=/d/code/samsam/evidence/itacc_r10/g1
source "$S/secret/env_samsam_itacc_r10_$1.sh"
export PYTHONIOENCODING=utf-8
cd /d/code/samsam
mkdir -p $EV/out $G/rep
# run TAG cmd... : chạy, ghi stdout+stderr vào $EV/out/TAG.txt, capture rc ngay
run() { local tag=$1; shift; { echo "\$ $*"; } > "$EV/out/$tag.txt"; "$@" >> "$EV/out/$tag.txt" 2>&1; local rc=$?; echo "[exit=$rc]" >> "$EV/out/$tag.txt"; echo "== $tag exit=$rc"; return 0; }
sql() { python "$G/sql.py" "$@"; }
res() { python "$G/res.py" "$@"; }
