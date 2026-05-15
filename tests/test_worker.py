"""Resume-aware behavior of `worker._run_rpc_blocking`.

These tests swap `robomp.worker.RpcClient` for a recording fake so we can
observe the `extra_args` and `set_todos` decisions the driver takes based on
whether the workspace's omp session directory already holds a JSONL transcript.
"""

from __future__ import annotations

import asyncio
import stat
from pathlib import Path
from types import SimpleNamespace

import pytest

from robomp import worker
from robomp.config import Settings


class _FakeRpcClient:
    instances: list[_FakeRpcClient] = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.set_todos_calls: list[list[dict]] = []
        self.get_todos_calls = 0
        self.stop_calls = 0
        _FakeRpcClient.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def install_headless_ui(self) -> None:
        pass

    def on_tool_execution_end(self, _cb) -> None:
        pass

    def on_message_update(self, _cb) -> None:
        pass

    def stop(self) -> None:
        self.stop_calls += 1

    def set_todos(self, phases):
        self.set_todos_calls.append(phases)

    def get_todos(self):
        self.get_todos_calls += 1
        return ()

    def prompt_and_wait(self, prompt, timeout):
        class _Turn:
            messages: list = []
            events: list = []
            assistant_text: str = "ok"

        return _Turn()


_SEEDED_PHASES = [
    {
        "id": "p1",
        "name": "Reproduce",
        "tasks": [
            {
                "id": "t1",
                "content": "do it",
                "status": "pending",
                "notes": "",
                "details": "",
            }
        ],
    }
]


def _make_inputs(
    tmp_path: Path, settings: Settings, *, session_has_jsonl: bool, slot_uid: int | None = None
) -> tuple[worker.TaskInputs, SimpleNamespace]:
    root = tmp_path / "workspace"
    root.mkdir()
    session_dir = root / "session"
    session_dir.mkdir()
    if session_has_jsonl:
        (session_dir / "foo.jsonl").write_text("{}\n", encoding="utf-8")
    repo_dir = root / "repo"
    repo_dir.mkdir()

    workspace = SimpleNamespace(
        root=root,
        session_dir=session_dir,
        repo_dir=repo_dir,
        branch="robomp/issue-1",
    )
    repo = SimpleNamespace(full_name="acme/widgets", owner="acme", name="widgets")
    issue = SimpleNamespace(repo="acme/widgets", number=1, title="bug")

    db = SimpleNamespace(set_event_model=lambda _did, _model: None)
    github = SimpleNamespace()

    inputs = worker.TaskInputs(
        settings=settings,
        db=db,  # type: ignore[arg-type]
        github=github,  # type: ignore[arg-type]
        git_transport=SimpleNamespace(),  # type: ignore[arg-type]
        repo=repo,  # type: ignore[arg-type]
        issue=issue,  # type: ignore[arg-type]
        workspace=workspace,  # type: ignore[arg-type]
        delivery_id="d-test",
        attempts=0,
        slot_uid=slot_uid,
    )
    bindings = SimpleNamespace(
        workspace=workspace,
        repo=repo,
        issue=issue,
        issue_key=f"{repo.full_name}#{issue.number}",
    )
    return inputs, bindings


@pytest.fixture(autouse=True)
def _reset_fake() -> None:
    _FakeRpcClient.instances.clear()


@pytest.fixture(autouse=True)
def _patch_worker(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("robomp.worker.RpcClient", _FakeRpcClient)
    monkeypatch.setattr("robomp.worker._AGENT_HOME_STAGE", tmp_path / "missing-agent-home-stage")
    monkeypatch.setattr("robomp.worker.host_tools.build", lambda _b: ())
    monkeypatch.setattr(
        "robomp.worker.persona.system_append",
        lambda *, repo, issue, workspace: "SYS",
    )
    monkeypatch.setattr(
        "robomp.worker.persona.seed_phases",
        lambda _kind: [dict(p) for p in _SEEDED_PHASES],
    )


@pytest.mark.asyncio
async def test_run_rpc_passes_continue_when_session_jsonl_present(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    assert _FakeRpcClient.instances[0].kwargs["extra_args"] == ("--continue",)


@pytest.mark.asyncio
async def test_run_rpc_omits_continue_when_session_empty(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_home = tmp_path / "agent-home"
    agent_home.mkdir()
    monkeypatch.setattr(worker, "_AGENT_HOME", agent_home)

    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    assert _FakeRpcClient.instances[0].kwargs["extra_args"] == ()
    client_kwargs = _FakeRpcClient.instances[0].kwargs
    assert client_kwargs["env"]["HOME"] == str(agent_home)
    assert client_kwargs["env"]["GITHUB_TOKEN"] == ""
    assert client_kwargs["env"]["GITHUB_WEBHOOK_SECRET"] == ""
    assert client_kwargs["env"]["ROBOMP_REPLAY_TOKEN"] == ""
    assert client_kwargs["env"]["ROBOMP_GH_PROXY_HMAC_KEY"] == ""
    assert client_kwargs["user"] is None
    assert client_kwargs["group"] is None
    assert client_kwargs["extra_groups"] is None


def test_build_extra_env_stages_agent_home(tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    stage_home = tmp_path / "agent-home-stage"
    agent_home = tmp_path / "agent-home"
    monkeypatch.setattr(worker, "_AGENT_HOME_STAGE", stage_home)
    monkeypatch.setattr(worker, "_AGENT_HOME", agent_home)

    agent_dir = stage_home / ".agent"
    agent_rules_dir = agent_dir / "rules"
    omp_agent_dir = stage_home / ".omp" / "agent"
    agent_rules_dir.mkdir(parents=True)
    omp_agent_dir.mkdir(parents=True)
    (agent_dir / "AGENTS.md").write_text("agent instructions\n", encoding="utf-8")
    (agent_rules_dir / "rule.md").write_text("rule\n", encoding="utf-8")
    (omp_agent_dir / "models.yml").write_text("models: []\n", encoding="utf-8")

    env = worker._build_extra_env(settings)

    assert env["HOME"] == str(agent_home)
    assert (agent_home / ".agent" / "AGENTS.md").is_file()
    assert (agent_home / ".agent" / "rules" / "rule.md").is_file()
    assert (agent_home / ".omp" / "agent" / "models.yml").is_file()
    assert (agent_home / ".agent").stat().st_mode & 0o777 == 0o755
    assert (agent_home / ".agent" / "AGENTS.md").stat().st_mode & 0o777 == 0o644
    assert (agent_home / ".agent" / "rules").stat().st_mode & 0o777 == 0o755
    assert (agent_home / ".agent" / "rules" / "rule.md").stat().st_mode & 0o777 == 0o644
    assert (agent_home / ".omp" / "agent").stat().st_mode & 0o777 == 0o755
    assert (agent_home / ".omp" / "agent" / "models.yml").stat().st_mode & 0o777 == 0o644


@pytest.mark.asyncio
async def test_run_rpc_omits_home_when_agent_home_absent(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(worker, "_AGENT_HOME", tmp_path / "missing-agent-home")

    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    client_kwargs = _FakeRpcClient.instances[0].kwargs
    assert "HOME" not in client_kwargs["env"]
    assert client_kwargs["env"]["GITHUB_TOKEN"] == ""
    assert client_kwargs["env"]["GITHUB_WEBHOOK_SECRET"] == ""
    assert client_kwargs["env"]["ROBOMP_REPLAY_TOKEN"] == ""
    assert client_kwargs["env"]["ROBOMP_GH_PROXY_HMAC_KEY"] == ""


@pytest.mark.asyncio
async def test_run_rpc_uses_workspace_xdg_dirs_without_slot(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False, slot_uid=None)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    env = _FakeRpcClient.instances[0].kwargs["env"]
    xdg_root = inputs.workspace.root / ".omp-xdg"
    for key in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        path = Path(env[key])
        assert path.is_relative_to(xdg_root)
        assert (path / "omp").is_dir()
    tmpdir = inputs.workspace.root / ".omp-tmp"
    assert env["TMPDIR"] == str(tmpdir)
    assert env["TMP"] == str(tmpdir)
    assert env["TEMP"] == str(tmpdir)
    assert tmpdir.is_dir()
    assert stat.S_IMODE(tmpdir.stat().st_mode) == 0o700


@pytest.mark.asyncio
async def test_run_rpc_chowns_workspace_xdg_dirs_for_slot(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    chown_calls: list[tuple[Path, int, int]] = []
    monkeypatch.setattr("robomp.worker.os.geteuid", lambda: 0)
    monkeypatch.setattr("robomp.worker.os.chown", lambda path, uid, gid: chown_calls.append((Path(path), uid, gid)))

    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False, slot_uid=2001)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    env = _FakeRpcClient.instances[0].kwargs["env"]
    expected_dirs = set()
    for key in ("XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        base = Path(env[key])
        expected_dirs.update({base, base / "omp"})
    assert set(chown_calls) == {(path, 0, 2001) for path in expected_dirs}


@pytest.mark.asyncio
async def test_run_rpc_skips_set_todos_on_resumed_triage(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    assert _FakeRpcClient.instances[0].set_todos_calls == []


@pytest.mark.asyncio
async def test_run_rpc_seeds_todos_on_fresh_triage(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    calls = _FakeRpcClient.instances[0].set_todos_calls
    assert len(calls) == 1
    assert calls[0] == _SEEDED_PHASES


@pytest.mark.asyncio
async def test_run_rpc_merges_todos_on_followup_with_resume(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=True)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="handle_comment",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    client = _FakeRpcClient.instances[0]
    assert client.get_todos_calls == 1
    assert len(client.set_todos_calls) == 1
    assert len(client.set_todos_calls[0]) == len(_SEEDED_PHASES)


@pytest.mark.asyncio
async def test_run_rpc_passes_slot_uid_user_slot_group_and_omp_extra_group(tmp_path: Path, settings: Settings) -> None:
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False, slot_uid=2001)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()
    client_kwargs = _FakeRpcClient.instances[0].kwargs
    assert client_kwargs["user"] == 2001
    assert client_kwargs["group"] == 2001
    assert client_kwargs["extra_groups"] == ["omp"]


@pytest.mark.asyncio
async def test_run_rpc_arms_hard_timeout_timer(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    timers = []

    class FakeTimer:
        def __init__(self, interval, function):
            self.interval = interval
            self.function = function
            self.daemon = False
            self.started = False
            self.cancelled = False
            timers.append(self)

        def start(self) -> None:
            self.started = True

        def cancel(self) -> None:
            self.cancelled = True

    monkeypatch.setattr("robomp.worker.threading.Timer", FakeTimer)
    settings.task_timeout_seconds = 3.0
    settings.task_timeout_hard_grace_seconds = 7.0
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        worker._run_rpc_blocking(
            inputs,
            task_kind="triage_issue",
            prompt="x",
            loop=loop,
            bindings=bindings,  # type: ignore[arg-type]
        )
    finally:
        loop.close()

    assert len(timers) == 1
    timer = timers[0]
    assert timer.interval == 10.0
    assert timer.daemon is True
    assert timer.started is True
    assert timer.cancelled is True


@pytest.mark.asyncio
async def test_run_rpc_hard_timeout_stops_client_and_fails(
    tmp_path: Path, settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FiringTimer:
        def __init__(self, interval, function):
            self.interval = interval
            self.function = function
            self.daemon = False
            self.cancelled = False

        def start(self) -> None:
            self.function()

        def cancel(self) -> None:
            self.cancelled = True

    monkeypatch.setattr("robomp.worker.threading.Timer", FiringTimer)
    inputs, bindings = _make_inputs(tmp_path, settings, session_has_jsonl=False)
    loop = asyncio.new_event_loop()
    try:
        with pytest.raises(TimeoutError, match="hard timeout"):
            worker._run_rpc_blocking(
                inputs,
                task_kind="triage_issue",
                prompt="x",
                loop=loop,
                bindings=bindings,  # type: ignore[arg-type]
            )
    finally:
        loop.close()

    assert _FakeRpcClient.instances[0].stop_calls == 1
