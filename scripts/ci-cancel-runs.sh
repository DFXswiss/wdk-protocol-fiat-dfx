#!/usr/bin/env bash
# Cancel leftover GitHub Actions runs for a closed pull request.
#
# Usage:
#   ci-cancel-runs.sh --repo OWNER/REPO --pr NUMBER [--head-sha SHA] [--base-sha SHA]
# Optional: --dry-run
#
# Offline filter (selftest only; no network):
#   ci-cancel-runs.sh --from-json PATH --pr NUMBER [--head-sha SHA]
#   ci-cancel-runs.sh --from-json PATH --workflow-name NAME
#
# Live cancel is --pr / --head-sha / --base-sha only. There are no live
# --workflow-name mappings; every live --workflow-name (also combined with
# --pr / --head-sha / --base-sha) is rejected before any API call.
# Cancels runs in statuses: queued, pending, waiting, requested, in_progress.
# Never cancels GITHUB_RUN_ID when that env var is set (current run).
# --pr selects by pull request number in this repo only (not github.head_ref).
# After merge the list API often leaves pull_requests empty; --head-sha matches
# workflow_run.head_sha so leftover pull_request CI of the closed PR is still
# selected. --base-sha is only another list query: a shared base commit must
# not cancel another pull request once pull_requests is empty.
# Active pull_request_target runs are listed by event and status, because their
# head_sha is the base commit at start and a later base tip can miss them.
# Only pull_request and pull_request_target runs are cancelled. A push,
# schedule, or workflow_dispatch run on the same commit is left alone.
# The live list is paged until a short page or the reported total is in hand.
# A full page past the page cap is a cut-off and exits 1 before any cancel.
# No-op (nothing to cancel) exits 0.
# Cancel treats HTTP 202/409 as success. 502/503/429 retry then continue
# (best-effort — a GitHub blip must not fail the calling workflow).
set -euo pipefail

REPO=""
PR=""
HEAD_SHA=""
BASE_SHA=""
WORKFLOW_NAME=""
DRY_RUN=0
FROM_JSON=""

usage() {
  cat >&2 <<'EOF'
Usage:
  ci-cancel-runs.sh --repo OWNER/REPO --pr NUMBER [--head-sha SHA] [--base-sha SHA]
Optional: --dry-run
Offline (selftest): --from-json PATH with --pr [--head-sha SHA] or --workflow-name
Live has no --workflow-name mappings; every live --workflow-name is rejected
(including combined with --pr / --head-sha / --base-sha).
EOF
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO=${2:-}
      shift 2
      ;;
    --pr)
      PR=${2:-}
      shift 2
      ;;
    --head-sha)
      HEAD_SHA=${2:-}
      shift 2
      ;;
    --base-sha)
      BASE_SHA=${2:-}
      shift 2
      ;;
    --workflow-name)
      WORKFLOW_NAME=${2:-}
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --from-json)
      FROM_JSON=${2:-}
      shift 2
      ;;
    -h | --help)
      usage
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      ;;
  esac
done

if [[ -z "$PR" && -z "$WORKFLOW_NAME" ]]; then
  echo "error: require --pr NUMBER or --workflow-name NAME" >&2
  usage
fi

if [[ -z "$FROM_JSON" && -z "$REPO" ]]; then
  echo "error: --repo OWNER/REPO is required unless --from-json is set" >&2
  usage
fi

if [[ -n "$FROM_JSON" && ! -f "$FROM_JSON" ]]; then
  echo "error: --from-json path not found: $FROM_JSON" >&2
  exit 1
fi

# Live has no --workflow-name mappings. Reject every live --workflow-name
# (including combined with --pr / --head-sha) before curl / tmpdir / api_get.
if [[ -z "$FROM_JSON" && -n "$WORKFLOW_NAME" ]]; then
  echo "error: no live --workflow-name mappings (use --pr / --head-sha / --base-sha)" >&2
  exit 1
fi

# Filter a GitHub Actions runs JSON fixture (array or { "workflow_runs": [...] }).
# Prints one databaseId/id per line that should be cancelled.
# Env: FILTER_PR, FILTER_HEAD_SHA, FILTER_WORKFLOW_NAME, GITHUB_RUN_ID (optional).
filter_cancel_ids() {
  FILTER_PR="${PR}" \
    FILTER_HEAD_SHA="${HEAD_SHA}" \
    FILTER_WORKFLOW_NAME="${WORKFLOW_NAME}" \
    python3 -c '
import json, os, sys

ACTIVE = {"queued", "pending", "waiting", "requested", "in_progress"}
PROTECTED = set()

raw = sys.stdin.read()
data = json.loads(raw)
if isinstance(data, dict):
    runs = data.get("workflow_runs", [])
elif isinstance(data, list):
    runs = data
else:
    raise SystemExit("error: runs JSON must be a list or {\"workflow_runs\": [...]}")

filter_pr = os.environ.get("FILTER_PR") or ""
filter_sha = (os.environ.get("FILTER_HEAD_SHA") or "").lower()
filter_wf = os.environ.get("FILTER_WORKFLOW_NAME") or ""
self_id = os.environ.get("GITHUB_RUN_ID") or ""

def run_id(r):
    rid = r.get("databaseId", r.get("id"))
    return None if rid is None else str(rid)

def run_name(r):
    return r.get("workflowName") or r.get("name") or ""

def pr_numbers(r):
    prs = r.get("pull_requests")
    if prs is None:
        return None
    out = []
    for p in prs:
        if isinstance(p, dict) and p.get("number") is not None:
            out.append(int(p["number"]))
    return out

for r in runs:
    if not isinstance(r, dict):
        continue
    status = r.get("status") or ""
    if status not in ACTIVE:
        continue
    name = run_name(r)
    if name in PROTECTED:
        continue
    rid = run_id(r)
    if rid is None:
        continue
    if self_id and rid == str(self_id):
        continue
    if filter_wf and name != filter_wf:
        continue
    if filter_pr:
        nums = pr_numbers(r)
        head = (r.get("head_sha") or r.get("headSha") or "")
        if isinstance(head, str):
            head = head.lower()
        else:
            head = ""
        # After merge, pull_requests is often []. Match head_sha when given.
        event = r.get("event") or ""
        if not isinstance(event, str):
            event = ""
        pr_event = event in ("pull_request", "pull_request_target")
        matched_pr = nums is not None and int(filter_pr) in nums
        matched_sha = bool(filter_sha) and head == filter_sha
        # Same commit can also have push, schedule, or workflow_dispatch runs.
        # pull_requests is [] for those. Cancel only pull-request events.
        if nums:
            if not matched_pr or not pr_event:
                continue
        elif nums == []:
            if not matched_sha or not pr_event:
                continue
        elif filter_sha:
            if not matched_sha or not pr_event:
                continue
        # nums is None (no field) and no sha: keep (pre-scoped fixture / list)
    print(rid)
'
}

api_token() {
  printf '%s' "${GH_TOKEN:-${GITHUB_TOKEN:-}}"
}

api_get() {
  local url=$1
  local token
  token=$(api_token)
  if [[ -z "$token" ]]; then
    echo "error: GH_TOKEN or GITHUB_TOKEN is required" >&2
    exit 1
  fi
  curl -sS -f \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$url"
}

api_cancel() {
  local id=$1
  local token
  token=$(api_token)
  local base=${GITHUB_API_URL:-https://api.github.com}
  # 202 = accepted; 409 = already completed. Both are success.
  # 502/503/429 are retried. A transient outage must not fail the closing workflow.
  local code=""
  local attempt=0
  local max=6
  while ((attempt < max)); do
    attempt=$((attempt + 1))
    code=$(curl -sS -o /dev/null -w '%{http_code}' \
      -X POST \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/vnd.github+json" \
      -H "X-GitHub-Api-Version: 2022-11-28" \
      "${base}/repos/${REPO}/actions/runs/${id}/cancel")
    if [[ "$code" == "202" || "$code" == "409" ]]; then
      return 0
    fi
    if [[ "$code" == "502" || "$code" == "503" || "$code" == "429" ]]; then
      echo "cancel run ${id} returned HTTP ${code}, retry ${attempt}/${max}" >&2
      sleep "$attempt"
      continue
    fi
    echo "error: cancel run ${id} returned HTTP ${code}" >&2
    exit 1
  done
  echo "warning: cancel run ${id} still HTTP ${code} after ${max} retries; continuing" >&2
  return 0
}

if [[ -n "$FROM_JSON" ]]; then
  ids=$(filter_cancel_ids <"$FROM_JSON")
else
  if ! command -v curl >/dev/null 2>&1; then
    echo "error: curl is required to list/cancel runs" >&2
    exit 1
  fi
  base=${GITHUB_API_URL:-https://api.github.com}
  tmpdir=$(mktemp -d)
  trap 'rm -rf "$tmpdir"' EXIT
  # Live --workflow-name is rejected above (before curl / tmpdir).
  # Page each query until a short page or total_count is covered. Stop and
  # fail closed when the cap is hit while the last page is still full,
  # before any cancel. head_sha finds pull_request runs. base_sha and the
  # active pull_request_target statuses find guard runs whose head_sha is
  # the base commit. The PR-number filter still drops other pull requests.
  page_query() {
    local label=$1
    local extra=$2
    local page=1
    local max_pages=100
    local count=""
    local total=""
    local collected=0
    while true; do
      api_get "${base}/repos/${REPO}/actions/runs?per_page=100&page=${page}&${extra}" \
        >"$tmpdir/${label}-${page}.json"
      read -r count total <<<"$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
runs = data.get("workflow_runs") or []
total = data.get("total_count")
print(len(runs), "" if total is None else int(total))
' "$tmpdir/${label}-${page}.json")"
      if [[ "$count" -lt 100 ]]; then
        collected=$(((page - 1) * 100 + count))
        if [[ -n "$total" && "$collected" -lt "$total" ]]; then
          echo "error: actions run list ${label} ended after ${collected} of ${total}" >&2
          exit 1
        fi
        break
      fi
      if [[ -n "$total" && $((page * 100)) -ge "$total" ]]; then
        break
      fi
      if [[ "$page" -ge "$max_pages" ]]; then
        echo "error: actions run list ${label} is cut off after ${page} pages" >&2
        exit 1
      fi
      page=$((page + 1))
    done
  }
  if [[ -n "$HEAD_SHA" ]]; then
    page_query head "head_sha=${HEAD_SHA}"
  fi
  if [[ -n "$BASE_SHA" && "$BASE_SHA" != "$HEAD_SHA" ]]; then
    page_query base "head_sha=${BASE_SHA}"
  fi
  if [[ -n "$PR" ]]; then
    for status in queued pending waiting requested in_progress; do
      page_query "target-${status}" "event=pull_request_target&status=${status}"
    done
  fi
  raw=$(python3 -c '
import json, pathlib, sys
runs = []
for p in sys.argv[1:]:
    data = json.loads(pathlib.Path(p).read_text())
    runs.extend(data.get("workflow_runs") or [])
print(json.dumps(runs))
' "$tmpdir"/*.json)
  ids=$(filter_cancel_ids <<<"$raw")
fi

if [[ -z "${ids//[$'\t\n\r ']/}" ]]; then
  echo "ci-cancel-runs: nothing to cancel"
  exit 0
fi

while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "would cancel run $id"
  else
    if [[ -z "$REPO" ]]; then
      # --from-json without --repo: print selected ids only (selftest path).
      echo "$id"
      continue
    fi
    echo "cancelling run $id"
    api_cancel "$id"
  fi
done <<<"$ids"

exit 0
