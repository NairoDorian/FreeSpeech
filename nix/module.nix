# GENERATED FILE — DO NOT EDIT.
#
# Source: `scripts/app-meta.ts` — run `bun run meta:sync` to regenerate.
#
# NixOS module for FreeSpeech speech-to-text.
#
# Handles system-level configuration that the package wrapper cannot:
#   - udev rule for /dev/uinput (the handy-keys evdev grab re-injects
#     through virtual input devices; dotool / ydotool typing uses it too)
#
# Note: users must add themselves to the "input" group for evdev hotkey access.
#
# Usage in your flake:
#
#   inputs.freespeech.url = "https://github.com/NairoDorian/FreeSpeech";
#
#   nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
#     modules = [
#       freespeech.nixosModules.default
#       { programs.freespeech.enable = true; }
#     ];
#   };
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.freespeech;
in
{
  options.programs.freespeech = {
    enable = lib.mkEnableOption "FreeSpeech offline speech-to-text";

    package = lib.mkOption {
      type = lib.types.package;
      defaultText = lib.literalExpression "freespeech.packages.\${system}.freespeech";
      description = "The FreeSpeech package to use.";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ cfg.package ];

    # handy-keys' evdev grab creates virtual input devices via /dev/uinput.
    # Default permissions are crw------- root root — open it to the input group.
    services.udev.extraRules = ''
      KERNEL=="uinput", GROUP="input", MODE="0660"
    '';
  };
}
