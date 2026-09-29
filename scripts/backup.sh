#!/usr/bin/env bash
# Take a logical backup of the SideStage database, and restore one.
#
# WHY THIS EXISTS. On 2026-09-28 the account held ZERO snapshots, no DLM
# lifecycle policy and no AWS Backup plan — checked, not assumed:
#
#   aws ec2 describe-snapshots --owner-ids self --query 'length(Snapshots)' → 0
#   aws dlm get-lifecycle-policies                                         → []
#   aws backup list-backup-plans                                           → []
#
# Everything this product holds sat on one unreplicated 24 GB gp3 volume attached
# to one t3.small: every seller's account, their sealed eBay tokens, every show's
# chat — other people's words — every hash-chained audit log, every report, the
# host's recorded audio and camera frames, and the signed-in eBay browser
# profile. Lose the volume and all of it is gone.
#
# A logical dump rather than an EBS snapshot, deliberately: it restores onto any
# Postgres anywhere, it is a few megabytes rather than 24 GB, it needs no AWS
# permissions, and it costs nothing to keep. It does NOT cover the media files
# under data/ — see MEDIA below, which says so rather than implying otherwise.
#
#   ./scripts/backup.sh dump  [dir]     pull a compressed dump off the box
#   ./scripts/backup.sh verify <file>   check a dump is readable and non-trivial
#   ./scripts/backup.sh restore <file> [url]   restore into a database
#
# The restore path is tested — `test/a-backup-nobody-restored.test.ts` runs a
# real dump-and-restore round trip against a scratch database — because a backup
# nobody has restored is a hope.
set -euo pipefail

KEY=${SIDESTAGE_KEY:-sidestage}
PEM=${SIDESTAGE_PEM:-$HOME/.ssh/$KEY.pem}
REGION=${AWS_REGION:-us-east-1}
DB=${SIDESTAGE_DB:-sidestage}
DBUSER=${SIDESTAGE_DBUSER:-sidestage}

instance_id() {
  aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=sidestage-backend" "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[0].InstanceId' --output text 2>/dev/null | tr -d '\n'
}
public_ip() {
  aws ec2 describe-instances --region "$REGION" --instance-ids "$1" \
    --query 'Reservations[].Instances[0].PublicIpAddress' --output text | tr -d '\n'
}

cmd_dump() {
  OUT_DIR=${1:-./backups}
  mkdir -p "$OUT_DIR"
  # A dump holds every seller's scrypt hash, every sealed eBay token, every
  # buyer's chat and the whole audit chain. It must not be committable.
  #
  # This is not hypothetical: `backups/` was NOT in .gitignore when the first
  # dump was written into it, and this repo gets `git add -A`. One commit and a
  # production credential set is in git history, where removing it means
  # rewriting history and rotating everything.
  #
  # So: refuse a destination git would track. Checked with git itself rather than
  # by matching path strings, because the rule that matters is the one git
  # applies.
  if git -C "$(dirname "$0")/.." rev-parse --git-dir > /dev/null 2>&1; then
    PROBE="$OUT_DIR/.gitignore-probe.sql.gz"
    : > "$PROBE"
    if ! git -C "$(dirname "$0")/.." check-ignore -q "$PROBE" 2>/dev/null; then
      rm -f "$PROBE"
      cat >&2 <<EOF
!! git would TRACK a dump written to $OUT_DIR
   A dump holds every seller's password hash, every sealed eBay token, every
   buyer's chat and the whole audit chain. Committing one puts all of it in git
   history, where the fix is rewriting history and rotating every credential.

   Add the directory to .gitignore, or write the dump somewhere outside the repo:
     $0 dump ~/sidestage-backups
EOF
      exit 1
    fi
    rm -f "$PROBE"
  fi
  IID=$(instance_id); [ -n "$IID" ] || { echo "no running sidestage-backend instance" >&2; exit 1; }
  IP=$(public_ip "$IID")
  STAMP=$(date -u +%Y%m%dT%H%M%SZ)
  OUT="$OUT_DIR/sidestage-$STAMP.sql.gz"
  # Through the db container, so the client version always matches the server's.
  # `--no-owner` keeps the dump restorable by whatever role the target uses.
  ssh -i "$PEM" -o StrictHostKeyChecking=accept-new "ubuntu@$IP" \
    "cd /opt/sidestage && sudo docker compose --env-file .deploy.env exec -T db pg_dump -U $DBUSER --no-owner --clean --if-exists $DB" \
    | gzip -9 > "$OUT"
  cmd_verify "$OUT"
  echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
  cat <<EOF

  NOT in this dump: the media under /opt/sidestage/data — the host audio and
  camera frames of every recorded show, and the signed-in eBay browser profile.
  They are files, not rows. To take them too:
    ssh -i $PEM ubuntu@$IP 'sudo tar -C /opt/sidestage -czf - data' > $OUT_DIR/media-$STAMP.tar.gz
EOF
}

cmd_verify() {
  FILE=${1:?a dump file}
  # Three things, in the order they go wrong: it decompresses, it is a Postgres
  # dump, and it is not an empty one. A truncated pipe produces a valid gzip of
  # nothing, which is the backup that looks fine until the day it matters.
  #
  # STREAMED, not buffered. The first version of this did `BODY=$(gzip -dc …)`
  # and then grepped `echo "$BODY"`, which failed on a real dump — a few megabytes
  # through a shell variable and an `echo` argument — and reported "not a pg_dump"
  # about a perfectly good file. The round-trip test caught it, which is the whole
  # reason that test dumps a real database instead of a fixture. It also matters
  # on the box: buffering the dump in memory is the last thing a 2 GB machine
  # running Postgres and a Chrome needs.
  #
  # And NOT `grep -q` under `set -o pipefail`: -q exits the moment it matches, gzip
  # takes SIGPIPE, and the PIPELINE reports failure even though the match
  # succeeded — so a valid dump was rejected as "not a pg_dump". Without -q, grep
  # reads to the end and gzip finishes cleanly.
  gzip -t "$FILE"
  gzip -dc "$FILE" | grep "PostgreSQL database dump" > /dev/null || { echo "not a pg_dump: $FILE" >&2; exit 1; }
  for t in shows chat_messages audit show_reports accounts; do
    gzip -dc "$FILE" | grep "CREATE TABLE public.$t" > /dev/null || { echo "dump is missing table $t: $FILE" >&2; exit 1; }
  done
  LINES=$(gzip -dc "$FILE" | wc -l | tr -d ' ')
  [ "$LINES" -gt 200 ] || { echo "dump has only $LINES lines — truncated?" >&2; exit 1; }
  echo "ok: $FILE — $LINES lines, every expected table present"
}

cmd_restore() {
  FILE=${1:?a dump file}
  URL=${2:-${SIDESTAGE_RESTORE_URL:-}}
  [ -n "$URL" ] || { echo "usage: $0 restore <file> <postgres-url>" >&2; exit 1; }
  # The database name, EXACTLY — not a prefix. The first version of this matched
  # `*"/$DB"?*`, which refused `sidestage_restore_probe` because it starts with
  # `sidestage`: a guard against the wrong restore that blocked the right one.
  TARGET_DB=${URL##*/}
  TARGET_DB=${TARGET_DB%%\?*}
  if [ "$TARGET_DB" = "$DB" ]; then
    echo "!! that URL names the LIVE database ($DB). Restore into a scratch database and promote it." >&2
    exit 1
  fi
  cmd_verify "$FILE"
  # `--clean --if-exists` is in the dump, so this is idempotent against a target
  # that already has the schema.
  gzip -dc "$FILE" | psql "$URL" -v ON_ERROR_STOP=1 -q
  echo "restored $FILE into $URL"
}

case "${1:-}" in
  dump)    shift; cmd_dump "$@" ;;
  verify)  shift; cmd_verify "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  *) sed -n '28,32p' "$0"; exit 1 ;;
esac
