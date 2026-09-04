# Hermes Web — persistent systemd service for the WEB build of the Hermes
# Desktop renderer (hermes-mobile). Serves ONLY the production build
# (vite preview from apps/web-desktop/dist) on 0.0.0.0:4174 as its OWN process.
#
# The dashboard on 9119 (and the gateway) are SEPARATE services
# (hermes-dashboard / hermes-agent from the main nix-config) — this module
# neither touches nor installs them. The dynamic vite proxy (/api, /auth,
# /login, /api/ws) points to the gateway (default http://127.0.0.1:9119).
#
# Wiring in the main nix-config (home-manager), e.g. flakes/*.nix:
#   imports = [ inputs.hermes-mobile.homeManagerModules.hermes-web ];
#   services.hermes-web.enable    = true;
#   services.hermes-web.directory = "/home/ubuntu/Main/Code/hermes-mobile";
#
# Requirements in `directory`: a production build in apps/web-desktop/dist
# (pnpm --filter web-desktop run build or `nix build`) + node_modules.
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
        Repo root with web-desktop (must have a build in
        apps/web-desktop/dist and installed node_modules). vite preview needs
        node_modules at runtime (runtime vite + proxy plugin).
      '';
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "0.0.0.0";
      description = "Address the preview listens on (tsbridge → 127.0.0.1:4174).";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4174;
      description = "Preview port — must match the backend_addr of the tsbridge (hermes-web) service.";
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ pkgs.nodejs_24 pkgs.pnpm ];

    systemd.user.services.hermes-web = {
      Unit = {
        Description = "Hermes Web (Hermes Desktop renderer) — production preview on :${toString cfg.port}";
        # Requires node + a dist at the repo root; no network.
        After = [ "network.target" ];
      };

      Service = {
        # PRODUCTION ONLY: `vite preview` (NOT `vite serve`/dev) — serves the
        # built dist. Production build only.
        WorkingDirectory = cfg.directory;
        ExecStart = "${pkgs.pnpm}/bin/pnpm --filter web-desktop run preview -- --host ${cfg.host} --port ${toString cfg.port}";
        Restart = "on-failure";
        RestartSec = "5s";
        # No build is done here before start — the dist is produced by `build`
        # or `nix build` (separately). The service serves whatever is in dist.
      };

      Install = {
        WantedBy = [ "default.target" ];
      };
    };
  };
}