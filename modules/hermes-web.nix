# Hermes Web — trwała usługa systemd dla WEB-owej wersji renderera Hermes
# Desktop (hermes-mobile). Serwuje WYŁĄCZNIE build produkcyjny
# (vite preview z apps/web-desktop/dist) na 0.0.0.0:4174 jako WŁASNY proces.
#
# Dashboard na 9119 (i gateway) to OSOBNE usługi (hermes-dashboard /
# hermes-agent z głównego nix-config) — ten moduł ich NIE dotyka ani nie
# instaluje. Proxy dynamiczne vite (/api, /auth, /login, /api/ws) kieruje do
# gatewaya (domyślnie http://127.0.0.1:9119).
#
# Wpięcie w głównym nix-config (home-manager), np. flakes/*.nix:
#   imports = [ inputs.hermes-mobile.homeManagerModules.hermes-web ];
#   services.hermes-web.enable    = true;
#   services.hermes-web.directory = "/home/ubuntu/Main/Code/hermes-mobile";
#
# Wymagania w directory: build produkcyjny w apps/web-desktop/dist
# (pnpm --filter web-desktop run build albo `nix build`) + node_modules.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.hermes-web;
in
{
  options.services.hermes-web = {
    enable = lib.mkEnableOption "Hermes Web — desktop-based renderer production preview on :4174";

    directory = lib.mkOption {
      type = lib.types.str;
      default = "/home/ubuntu/Main/Code/hermes-mobile";
      description = ''
        Koreń repo z web-desktop (musi mieć build w
        apps/web-desktop/dist oraz zainstalowane node_modules). vite preview
        potrzebuje node_modules w runtime (runtime vite + plugin proxy).
      '';
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Adres, na którym nasłuchuje preview (tsbridge → 127.0.0.1:4174).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4174;
      description = "Port preview — musi zgadzać się z backend_addr tsbridge (hermes-web).";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ pkgs.nodejs_24 pkgs.pnpm ];

    systemd.user.services.hermes-web = {
      Unit = {
        Description = "Hermes Web (Hermes Desktop renderer) — production preview on :${toString cfg.port}";
        # Wymaga, by node + dist istniały na koreniu repo; po sieci.
        After = [ "network.target" ];
      };

      Service = {
        # Tylko PRODUKCJA: `vite preview` (NIE `vite serve`/dev) — serwuje
        # zbudowany dist. Tylko build produkcyjny.
        WorkingDirectory = cfg.directory;
        ExecStart = "${pkgs.pnpm}/bin/pnpm --filter web-desktop run preview -- --host ${cfg.host} --port ${toString cfg.port}";
        Restart = "on-failure";
        RestartSec = "5s";
        # Zbudować build przed startem nie robimy tu — dist napędza `build`
        # albo `nix build` (osobno). Usługa serwuje to, co jest w dist.
      };

      Install = {
        WantedBy = [ "default.target" ];
      };
    };
  };
}
