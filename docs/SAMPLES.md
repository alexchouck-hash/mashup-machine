# Sample provenance

Every audio file in `src/audio/kit/`, and the evidence that we may redistribute
it. This file exists because the app may be monetized, and **"free to download"
is not "free to redistribute"** — the distinction that disqualified every pack
the obvious search returns.

## Licence

**CC0 1.0 Universal (Public Domain Dedication).** All files come from Sonic Pi's
bundled sample directory, `etc/samples` of
[sonic-pi-net/sonic-pi](https://github.com/sonic-pi-net/sonic-pi), branch `stable`.

Verified at source on 2026-08-16, reading the repository's own `LICENSE.md`
rather than a summary of it:

> All the bundled samples are individually licensed under a
> [CC0 1.0 Universal Public Domain Dedication](http://creativecommons.org/publicdomain/zero/1.0/).

CC0 permits commercial redistribution, requires no attribution, and imposes no
share-alike. The table below is kept anyway: attribution is not *required*, but
an auditable chain of title is the only thing that makes a licence worth having.

## What was deliberately NOT taken

**No `loop_*` files. Not one.** That same directory's `loop_amen` comes from a
Freesound upload marked CC0 whose own description identifies it as the Amen
break — The Winstons, 1969. Nobody can dedicate a 1969 commercial phonogram to
the public domain, so that CC0 stamp is void, and it has sat inside a widely
shipped CC0 collection for years. **A CC0 stamp is only as strong as the chain
behind it**, and the loops are where that chain is weakest.

**No `perc_impact1` / `perc_impact2`.** Both were downloaded, then dropped: they
carry only the directory-wide CC0 line with no per-file source, so their chain
cannot be inspected. Weak provenance is precisely where `loop_amen` hid. The
synthesized impact in `macros.ts` does the job instead.

Rejected sources, for the reason that actually matters here:

| Source | Why not |
|---|---|
| MusicRadar SampleRadar | *"you're welcome to use the samples in your music in any way you like — all we ask is that you don't re-distribute them."* |
| Pixabay | Forbids distributing content "on a Standalone basis"; a soundboard serving the unmodified file sits on that line. |
| 99Sounds, Cymatics, TriSamples, Wave Alchemy | Royalty-free for USE. Silent or negative on REDISTRIBUTION. |
| Hydrogen / DrumGizmo / AVLinux kits | Mostly CC-BY-SA or GPL. Share-alike on an asset bundled into a commercial app is a question worth not having. |

## Naming

`bd_808` ships in our kit as **`kick_deep`**. The audio is CC0 and fine to use;
the *name* is not ours. Roland holds registered trademarks on TR-808 / TR-909 /
TB-303. Never put "808" on a button, a filename, or a store listing.

## Why brevity is not a defence

Should anyone later argue a single drum hit is too short to matter: US courts
are split — *Bridgeport v. Dimension Films* (6th Cir. 2005) refused a de minimis
defence for sound recordings; *VMG Salsoul v. Ciccone* (9th Cir. 2016) allowed
one. The EU is stricter: *Pelham v. Hütter* (CJEU C-476/17, 2019) held that
reproducing even a very short fragment of a phonogram infringes unless it is
unrecognisable. A verbatim one-shot is a verbatim copy. **Chain of title is the
defence; brevity is not.**

## Residual risk, stated plainly

Freesound CC0 is an **uploader assertion**, not a verified chain of title.
Freesound's own FAQ concedes that users may unknowingly upload illegal content
and that they rely on community flagging rather than verification. `loop_amen`
is proof this is real rather than theoretical.

The mitigation is this table — source URL and SHA-256 captured **at download
time**, because Sonic Pi's own README already marks several source links
deprecated. Freesound uploads get deleted and relicensed; evidence not captured
now is gone. (Same reasoning as the keep-everything-you-pull rule in the sibling
tennis project: a point-in-time observation cannot be bought back later.)

## The files

Downloaded 2026-08-16 from
`https://raw.githubusercontent.com/sonic-pi-net/sonic-pi/stable/etc/samples/`.
33 files, 2.61 MB, FLAC. Kit names are mapped in `src/audio/sampleKit.ts`;
anything missing or undecodable silently falls back to the synthesized voice in
`drums.ts`, so a browser without FLAC support degrades rather than going silent.

| File | KB | SHA-256 (first 16) | Freesound source |
|---|---:|---|---|
| `bd_808` | 19 | `f8cae3f73c93622a` | http://freesound.org/people/EKVelika/sounds/208447/ |
| `bd_boom` | 45 | `1ece3f3fc0c5d7d2` | http://freesound.org/people/Snapper4298/sounds/157245/ |
| `bd_fat` | 5 | `3c53f83cd05d8bf3` | http://freesound.org/people/cubix/sounds/124386/ |
| `bd_haus` | 19 | `b9aa2aa81a8ccabc` | http://freesound.org/people/Rodrigo%20The%20Mad/sounds/137722/ |
| `bd_tek` | 21 | `031cd7d4b3b8ccd9` | http://freesound.org/people/DWSD/sounds/171104/ |
| `drum_cowbell` | 18 | `e2ee5f732b675858` | http://freesound.org/people/Neotone/sounds/75338/ |
| `drum_cymbal_closed` | 20 | `f3b9d6bb14f75ba0` | http://www.freesound.org/people/menegass/sounds/100053/ |
| `drum_cymbal_hard` | 90 | `be18750e383d09d2` | http://www.freesound.org/people/menegass/sounds/100056/ |
| `drum_cymbal_open` | 116 | `3a9cf6aacab05003` | http://www.freesound.org/people/menegass/sounds/100055/ |
| `drum_cymbal_pedal` | 22 | `af2cf5e259f3671d` | http://www.freesound.org/people/menegass/sounds/100054/ |
| `drum_cymbal_soft` | 58 | `ab4cee3de9beaf99` | http://www.freesound.org/people/menegass/sounds/100057/ |
| `drum_snare_hard` | 29 | `1b2325523ed2a93d` | http://www.freesound.org/people/menegass/sounds/100058/ |
| `drum_snare_soft` | 22 | `3da004f932da94c4` | http://www.freesound.org/people/menegass/sounds/100059/ |
| `drum_splash_hard` | 146 | `4a050000a71b313c` | http://www.freesound.org/people/menegass/sounds/100060/ |
| `drum_tom_hi_hard` | 34 | `18d53d2dac65d1cd` | http://www.freesound.org/people/menegass/sounds/100062/ |
| `drum_tom_lo_hard` | 43 | `e8caf199618dfee0` | http://www.freesound.org/people/menegass/sounds/100064/ |
| `drum_tom_mid_hard` | 35 | `712e960a8107edaf` | http://www.freesound.org/people/menegass/sounds/100066/ |
| `elec_blip` | 16 | `6d082528d45fe31a` | http://www.freesound.org/people/looppool/sounds/13121/ |
| `elec_snare` | 17 | `a5548c4e418864f9` | http://www.freesound.org/people/looppool/sounds/13146/ |
| `elec_tick` | 9 | `ac3fa3c78f8af150` | http://www.freesound.org/people/looppool/sounds/13113/ |
| `elec_wood` | 24 | `f046ea904a91f742` | http://www.freesound.org/people/looppool/sounds/13135/ |
| `misc_cineboom` | 522 | `a03bc3dd148809d8` | http://freesound.org/people/Northern_Monkey/sounds/177242/ |
| `perc_snap` | 22 | `09d5cc75cd9ef183` | http://www.freesound.org/people/SoundCollectah/sounds/109400/ |
| `perc_snap2` | 23 | `03242155cc005d9f` | http://www.freesound.org/people/Peram/sounds/158615/ |
| `perc_swash` | 55 | `c2d125db98ff2d79` | http://freesound.org/people/qubodup/sounds/60009/ |
| `perc_swoosh` | 38 | `99704b14314b4a24` | https://freesound.org/people/hullum/sounds/415580/ |
| `perc_till` | 94 | `c6a97c7fb370725c` | http://freesound.org/people/Zott820/sounds/209578/ |
| `sn_dolf` | 49 | `88d04c0cf427f1af` | http://freesound.org/people/Dolfeus/sounds/57534/ |
| `sn_dub` | 43 | `165ddba961a14430` | http://freesound.org/people/Adriak909/sounds/173142/ |
| `vinyl_backspin` | 117 | `ef64d5951df8fb86` | http://freesound.org/people/il112/sounds/182316/ |
| `vinyl_hiss` | 654 | `4e3fdaaff3399328` | http://freesound.org/people/veezay/sounds/130393/ |
| `vinyl_rewind` | 234 | `ad587a5598de7a12` | http://freesound.org/people/TasmanianPower/sounds/162493/ |
| `vinyl_scratch` | 16 | `2dc0fedcfeaa3088` | http://freesound.org/people/hello_flowers/sounds/28681/ |

## Levels

Swapping synthesis for samples changed the drum bus peaks, which invalidated the
trim solved for the synth voices. Re-measured live against the master limiter's
own `reduction`, all four layers on:

| Groove | `volume` 0.66 | `volume` 0.52 |
|---|---|---|
| Party | — | −0.92 dB |
| Hip Hop | — | 0.00 dB |
| Trap | −1.61 dB | 0.00 dB |

`BeatMachine.volume` is therefore **0.52**. This is not about making the drums
quieter for its own sake: a drum bus that pushes the MASTER limiter makes the
limiter duck the decks, so the child's own song pumps on every downbeat — and
limited drums sound flatter, not punchier.
