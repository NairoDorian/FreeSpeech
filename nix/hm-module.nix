# GENERATED FILE — DO NOT EDIT.
#
# Source: `scripts/app-meta.ts` — run `bun run meta:sync` to regenerate.
#
# Home-manager module for FreeSpeech speech-to-text.
#
# Provides a systemd user service for autostart.
# Usage: imports = [ freespeech.homeManagerModules.default ];
#        services.freespeech.enable = true;
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.freespeech;
in
{
  options.services.freespeech = {
    enable = lib.mkEnableOption "FreeSpeech speech-to-text user service";

    package = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression "freespeech.packages.\${system}.freespeech";
      description = "The FreeSpeech package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.services.freespeech = {
      Unit = {
        Description = "FreeSpeech speech-to-text";
        After = [ "graphical-session.target" ];
        PartOf = [ "graphical-session.target" ];
      };
      Service = {
        ExecStart = "${cfg.package}/bin/freespeech";
        Restart = "on-failure";
        RestartSec = 5;
      };
      Install.WantedBy = [ "graphical-session.target" ];
    };
  };
}
