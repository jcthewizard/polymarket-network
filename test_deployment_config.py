import importlib
import os
import sys
from pathlib import Path


def test_database_uses_custom_db_path(monkeypatch, tmp_path):
    db_file = tmp_path / "state" / "polymarket.db"
    monkeypatch.setenv("DB_PATH", str(db_file))

    sys.modules.pop("database", None)
    database = importlib.import_module("database")

    assert Path(database.DB_PATH) == db_file

    database.init_db()

    assert db_file.exists()


def test_server_uses_env_port(monkeypatch):
    monkeypatch.setenv("PORT", "8123")

    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    assert server.PORT == 8123


def test_server_autostarts_trader_when_enabled(monkeypatch):
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    monkeypatch.setattr(server.config, "TRADING_ENABLED", True)

    captured = {}

    def fake_start():
        captured["called"] = True
        return {"status": "started"}

    monkeypatch.setattr(server.autotrader, "start", fake_start)

    result = server.maybe_start_autotrader_on_boot()

    assert captured["called"] is True
    assert result == {"status": "started"}


def test_server_skips_trader_autostart_when_disabled(monkeypatch):
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    monkeypatch.setattr(server.config, "TRADING_ENABLED", False)

    def fail_start():
        raise AssertionError("autotrader.start should not run")

    monkeypatch.setattr(server.autotrader, "start", fail_start)

    result = server.maybe_start_autotrader_on_boot()

    assert result == {"status": "disabled"}
