<p align="center">
  <img src="assets/original/branding/aoe2rmside-icon-512.png" alt="AoE2RMSIDE icon" width="128" height="128">
</p>

<h1 align="center">AoE2RMSIDE</h1>

AoE2RMSIDE is a free, open-source Windows app for making random maps for Age
of Empires II: Definitive Edition. You write the map script, and AoE2RMSIDE
shows you the map it creates.

You do not need the game installed to write and preview scripts. Link your
game folder to open the game's own maps and to deploy your maps.

The preview comes from AoE2RMSIDE's own map generator, not from the game.
[How closely it matches the game](COMPATIBILITY.md) depends on the game
version.

## Get AoE2RMSIDE

Download the latest version from the
[releases page](https://github.com/aoe2control/AoE2RMSIDE/releases). It runs
on Windows 10 and 11 (64-bit). The downloads are not code-signed, so Windows
SmartScreen may warn the first time you start them; choose **More info**, then
**Run anyway**.

The installed version updates itself: when a newer release is out, choose
**Update** in the Output panel. To update the ZIP version, download the new
ZIP from the releases page.

To build it yourself, follow [BUILDING.md](BUILDING.md).

## Check your maps

Besides the preview, AoE2RMSIDE warns where the game itself is known to crash
on a script and says how to avoid it, and, with your game folder linked,
shows what your map's XS files do when the game starts. After each Run it can also run a quality check: it
generates the map on many seeds, optionally with other lobby settings, and
reports unfair or broken spots, such as a resource one player lacks, with the
seeds to look at. Map tests check your own rules the same way.

## Works with external language servers

AoE2RMSIDE has its own RMS and XS analysis. If you have a separate language
server installed, such as [XS Check](https://github.com/Divy1211/xs-check)
(it also comes with the XS extension for Visual Studio Code), AoE2RMSIDE finds
it and uses its errors, completion and hover alongside its own. See
[External language servers](https://aoe2control.github.io/aoe2rmside/writing-scripts/#external-language-servers).

## Works with AI apps

AI apps on your computer can use AoE2RMSIDE through MCP: read and edit the
scripts in your open folder, switch to your recent folders, generate maps
and look at pictures of them, run map tests and the quality check, deploy
maps when you ask, and start live tests after you allow them. Their edits stay unsaved until you save them. MCP
is off until you turn on **Enable MCP** under **View → MCP…**, and you allow
each app once. The scripts, results and map pictures an app asks for go to
that app, and from there to its provider; AoE2RMSIDE itself sends nothing
over the internet. See
[AI apps (MCP)](https://aoe2control.github.io/aoe2rmside/ai-apps/).

## Learn more

- [Documentation](https://aoe2control.github.io/aoe2rmside/): how to use
  AoE2RMSIDE.
- [Compatibility and game content](COMPATIBILITY.md): what the preview can
  and cannot promise, and how game files are handled.
- [Contributing](CONTRIBUTING.md): how to help, including translations (no
  coding needed).
- [Security](SECURITY.md): how to report a security problem privately.
- [Discord](https://discord.gg/CpVxzRfvm7): questions and ideas.

## License

AoE2RMSIDE is licensed under the [Apache License 2.0](LICENSE). Third-party
notices are listed in [NOTICE.md](NOTICE.md).

AoE2RMSIDE is an independent project. It is not affiliated with, endorsed by,
or sponsored by Microsoft, Xbox Game Studios, World's Edge, or Activision.
Age of Empires is a trademark of Microsoft Corporation.
