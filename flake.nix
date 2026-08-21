{
  description = "Hermes Web — the Hermes Desktop chat UI as a browser app. Builds ONLY the web UI of hermes-agent; nothing else (no electron, no dashboard, no agent tooling).";

  # hermes-agent is a plain input (flake = false): nix fetches it into the
  # store, pinned by flake.lock. Update upstream with `nix flake update hermes`.
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    hermes = {
      url = "github:NousResearch/hermes-agent";
      flake = false;
    };
  };

  outputs = { self, nixpkgs, flake-utils, hermes }:
    (flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_24;
        pnpm = pkgs.pnpm;
        root = toString ./.;

        # Our web code only (this repo), filtered to what the build needs.
        webSrc = builtins.path {
          path = ./.;
          name = "hermes-mobile-web";
          filter = path: type:
            let
              p = toString path;
              base = baseNameOf path;
              inWeb = builtins.match ".*/apps/web-desktop(/.*)?" p != null;
              inRoot = p == root || pkgs.lib.hasPrefix "${root}/" p;
              inStore = builtins.match ".*/(dist|logs|node_modules)(/.*)?" p != null;
            in
            !inStore && (
              (type == "directory" && (inRoot || inWeb)) ||
              (type == "regular" && (inRoot || inWeb))
            ) && base != ".npmrc";
        };

        # Build tree: our web code + the upstream renderer sources (pinned
        # input) placed at the relative paths our vite config expects
        # (../desktop/src, ../shared/src).
        src = pkgs.runCommand "hermes-web-src" { } ''
          mkdir -p $out
          cp -r ${webSrc}/. $out/
          # Store paths are read-only; make the copy writable so pnpm can
          # install into it later.
          chmod -R u+w $out
          # Drop any stale apps/desktop|apps/shared skeletons the source
          # filter may carry over from a full clone, then supply the real
          # renderer sources from the pinned input.
          rm -rf $out/apps/desktop $out/apps/shared
          mkdir -p $out/apps/desktop $out/apps/shared
          cp -r ${hermes}/apps/desktop/src $out/apps/desktop/src
          cp -r ${hermes}/apps/shared/src $out/apps/shared/src
        '';
      in
      {
        # `nix build .#` → result/ = the built web dist, nothing else.
        packages.default = pkgs.stdenv.mkDerivation {
          pname = "hermes-web";
          version = "0.1.0";

          inherit src;

          # pnpmConfigHook (nixpkgs) unpacks the FOD store tarball, rebuilds
          # the v11 index.db from the SQL dump (sqlite) and runs the offline
          # install with --trust-lockfile — the canonical pnpm 11 pattern.
          nativeBuildInputs = [ nodejs pnpm pkgs.zstd pkgs.sqlite pkgs.pnpmConfigHook ];

          # The hook's `pnpm config set` needs a writable HOME (sandbox HOME
          # is read-only /homeless-shelter).
          preConfigure = ''
            export HOME="$TMPDIR"
          '';

          # Fixed-output fetch of the pnpm dependency closure (network allowed
          # here; the build itself is offline). First build fails with the real
          # hash — paste it into pnpmDeps.hash and rebuild.
          pnpmDeps = pkgs.fetchPnpmDeps {
            pname = "hermes-web";
            version = "0.1.0";
            # v4: current fetcher for pnpm 11 (26.11+). Output is a pnpm
            # store dir (+ reproducible tarball), consumed via
            # `pnpm config set store-dir` in buildPhase.
            fetcherVersion = 4;
            inherit src;
            hash = "sha256-Z7Us8lAkYGQ9e8+yKExC2mHdu6hSYespuRX0W2z38RA=";
          };

          buildPhase = ''
            runHook preBuild
            pnpm --filter web-desktop run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out
            cp -r apps/web-desktop/dist/. $out/
            runHook postInstall
          '';
        };

        # `nix run .#` — serve the built dist through the SYSTEM hermes
        # (backend-with-UI mode) on 4174, same-origin. The nix-managed
        # dashboard on 9119 stays untouched.
        apps.default = {
          type = "app";
          program = "${pkgs.writeShellScript "hermes-web-serve" ''
            export HERMES_WEB_DIST=${self.packages.${system}.default}
            exec hermes dashboard --port 4174 --host 0.0.0.0 --skip-build --no-open
          ''}";
        };

        # `nix develop` — node+pnpm plus the renderer sources symlinked from
        # the pinned input, so dev works without any clone. Non-destructive:
        # symlinks are created only when the paths don't exist yet (a local
        # clone's apps/desktop+apps/shared keep being used if present).
        devShells.default = pkgs.mkShell {
          packages = [ nodejs pnpm ];
          shellHook = ''
            [ -e apps/desktop ] || ln -s ${hermes}/apps/desktop apps/desktop
            [ -e apps/shared ] || ln -s ${hermes}/apps/shared apps/shared
            echo "Hermes Web dev shell — renderer sources from the pinned upstream input."
            echo "  pnpm install && pnpm --filter web-desktop run dev"
          '';
        };
      })) // {
    # Moduł home-manager definiujący trwałą usługę systemd Hermes Web
    # (production preview renderera Hermes Desktop na :4174). Wpięcie w
    # głównym nix-config:
    #   imports = [ inputs.hermes-mobile.homeManagerModules.hermes-web ];
    #   services.hermes-web.enable = true;
    homeManagerModules = {
      default = import ./modules/hermes-web.nix;
      hermes-web = import ./modules/hermes-web.nix;
    };
  };
}
