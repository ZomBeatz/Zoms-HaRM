"""Docker containers on a device, over SSH (like actions): list them, check their images for updates,
and run one fixed operation at a time (update, restart, stop, start, logs, clean up).

Commands are built here from what the host itself reported, never from free text, and every name in
them is shell-quoted. Nothing runs on a schedule: each operation is one click.
"""

import json
import re
import shlex

# One JSON line per container (docker inspect templates keep the output small).
_FIELDS = ('{"name":{{json .Name}},"image":{{json .Config.Image}},"image_id":{{json .Image}},'
           '"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},'
           '"started":{{json .State.StartedAt}},"restarts":{{.RestartCount}},'
           '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
           '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
           '"workdir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},'
           '"configs":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},'
           '"ports":{{json .NetworkSettings.Ports}}}')
_NEED_DOCKER = 'command -v docker >/dev/null 2>&1 || { echo "HARM_NO_DOCKER"; exit 3; }\n'
LIST_SCRIPT = _NEED_DOCKER + f"docker ps -aq | xargs -r docker inspect --format {shlex.quote(_FIELDS)}\n"

# For each image in use: the digest it was pulled as, and the registry's current one (without
# downloading it). buildx is part of Docker Engine; without it the answer is "can't tell".
CHECK_SCRIPT = _NEED_DOCKER + r"""for img in $(docker ps -a --format '{{.Image}}' | sort -u); do
  local_d=$(docker image inspect --format '{{range .RepoDigests}}{{.}} {{end}}' "$img" 2>/dev/null | tr ' ' '\n' | sed -n 's/.*@//p' | head -1)
  remote_d=$(docker buildx imagetools inspect --format '{{json .Manifest.Digest}}' "$img" 2>/dev/null | tr -d '"')
  printf '{"image":"%s","local":"%s","remote":"%s"}\n' "$img" "$local_d" "$remote_d"
done
"""

PRUNE_SCRIPT = _NEED_DOCKER + "docker image prune -f\n"

_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
OPS = ("update", "restart", "stop", "start", "logs")


class DockerError(Exception):
    pass


def _check(output: str) -> None:
    if "HARM_NO_DOCKER" in output:
        raise DockerError("Docker isn't installed on that machine (or isn't on the login's PATH)")
    if re.search(r"permission denied.*docker\.sock", output, re.I):
        raise DockerError("That login can't use Docker. Tick “Use sudo”, or add the account to the docker group")


def _ports(raw) -> list[str]:
    out = []
    for cport, binds in (raw or {}).items():
        for b in binds or []:
            if b.get("HostPort"):
                out.append(f"{b['HostPort']}→{cport}")
    return sorted(set(out), key=lambda p: int(p.split("→")[0]) if p.split("→")[0].isdigit() else 0)


def parse_list(output: str) -> list[dict]:
    _check(output)
    rows = []
    for line in output.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            c = json.loads(line)
        except ValueError:
            continue
        name = (c.get("name") or "").lstrip("/")
        if not _NAME.match(name):
            continue
        rows.append({"name": name, "image": c.get("image") or "", "image_id": c.get("image_id") or "",
                     "state": c.get("state") or "unknown", "health": c.get("health"), "started": c.get("started") or "",
                     "restarts": c.get("restarts") or 0, "project": c.get("project") or "", "service": c.get("service") or "",
                     "workdir": c.get("workdir") or "", "configs": c.get("configs") or "", "ports": _ports(c.get("ports"))})
    return sorted(rows, key=lambda r: r["name"].lower())


def parse_check(output: str) -> dict:
    """{image: "update" | "current" | "unknown"}"""
    _check(output)
    out = {}
    for line in output.splitlines():
        try:
            r = json.loads(line)
        except ValueError:
            continue
        loc, rem = r.get("local") or "", r.get("remote") or ""
        out[r.get("image") or ""] = "unknown" if not (loc and rem) else ("current" if loc == rem else "update")
    return out


def op_script(c: dict, op: str) -> str:
    """The script for one operation on one container (a row from parse_list)."""
    if op not in OPS or not _NAME.match(c.get("name") or ""):
        raise DockerError("Unknown operation")
    q = shlex.quote(c["name"])
    if op == "logs":
        return _NEED_DOCKER + f"docker logs --tail 200 --timestamps {q} 2>&1\n"
    if op in ("restart", "stop", "start"):
        return _NEED_DOCKER + f"docker {op} {q}\n"
    # update: Compose containers are pulled and re-created by Compose, with their own settings.
    if not (c.get("project") and c.get("service") and c.get("workdir")):
        return _NEED_DOCKER + (f"docker pull {shlex.quote(c['image'])} && echo HARM_RESULT=pulled-only\n")
    files = " ".join(f"-f {shlex.quote(f)}" for f in (c.get("configs") or "").split(",") if f.strip())
    proj, svc = shlex.quote(c["project"]), shlex.quote(c["service"])
    return _NEED_DOCKER + f"""before=$(docker inspect -f '{{{{.Image}}}}' {q})
cd {shlex.quote(c['workdir'])} || exit 1
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
$DC -p {proj} {files} pull {svc} && $DC -p {proj} {files} up -d {svc} || exit 1
now=$(docker ps -q --filter label=com.docker.compose.project={proj} --filter label=com.docker.compose.service={svc} | head -1)
after=$(docker inspect -f '{{{{.Image}}}}' "$now")
if [ "$before" = "$after" ]; then echo HARM_RESULT=same; else echo HARM_RESULT=updated; fi
"""


def op_result(op: str, output: str) -> str:
    """A plain sentence for the message after an operation."""
    _check(output)
    if op == "update":
        if "HARM_RESULT=updated" in output:
            return "Updated to the newest image and started again."
        if "HARM_RESULT=same" in output:
            return "Already up to date."
        if "HARM_RESULT=pulled-only" in output:
            return ("Downloaded the newest image. This container wasn't started with Docker Compose, so HaRM can't "
                    "re-create it with the same settings: re-create it the way you started it.")
    return {"restart": "Restarted.", "stop": "Stopped.", "start": "Started.", "logs": ""}.get(op, "Done.")
