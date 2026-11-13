# Contamination (beta)

> **Beta:** results are for research use only; check calls against your gel and report problems.

A drag-and-drop web page for agarose gel images. It runs entirely in the browser, so images are never uploaded anywhere.

- **Ladder database**: NEB, Thermo GeneRuler, Invitrogen and Bioline ladders are preloaded. You can add or edit ladders in the app, and share them with the lab through `lab-ladders.json`.
- **Automatic rows and lanes**: rows are found from the wells of each comb, and lanes from the comb pitch. The gel size and comb (tooth count) presets help, and gel tilt is corrected.
- **Labels from Excel or CSV**: sample names are applied in lane order, including ladder lanes. Ladder lanes are recognised by name ("Ladder", "Marker", "L", "M").
- **Ladder sizing**: ladder bands are matched to the chosen ladder automatically. Bright reference bands are used, and all ladders on a gel are fitted consistently. Band sizes come from interpolating log(bp) against migration distance.
- **Present / faint / absent calls** at one or more expected band sizes (e.g. `550, 320`), each band called separately (±tolerance). Sizes can be set globally, per row, per lane, or in column B of the label sheet (`550; 320`). The Excel export has a *Band calls* sheet with one line per expected band.
- **Densitometry**: click any band to get its background-subtracted volume, its intensity relative to the row maximum or a chosen reference lane, its signal-to-noise, a **saturation warning** and the lane profile.
- **Exports**: annotated PNG, CSV, and Excel (results, ladder fit and settings sheets).

## Use it

Open the GitHub Pages URL, then drag a gel image onto the page. TIFF (8/16-bit), PNG and JPG are accepted.

- **Use the raw TIFF from the imager for quantification.** JPEGs and "for publication" exports are auto-contrasted and compressed. They're fine for band sizes and calls, but not for intensities.
- If auto-detection is off, turn on **Edit layout**:
  - Drag the lane handles (◆) or well lines.
  - Double-click to add a lane or row.
  - Shift-click to delete one.
- If a ladder is mis-assigned, fix individual bands in **Rows & ladder fit**.
- **Label style** (toolbar) sets the text size, the colours of lane labels, ladder sizes and band sizes, and can write the size under every called band.
- **Manual edits:** double-click a lane label, a band or a row-end size on the gel to change it, or use the Label and Band size fields under *Selected band* and the *Size label* field per row. Manually entered sizes are marked ✎ and exported with `Size_manual = yes`.

## Deploy on GitHub Pages (one time, about 2 minutes)

1. Create a new repository on GitHub, e.g. `contamination` (public, or private on a plan that allows Pages).
2. Upload the contents of this folder (`index.html`, `css/`, `js/`, `lab-ladders.json`, `sample-labels.csv`, `README.md`). Either drag them into the GitHub web page ("Add file → Upload files"), or from a terminal:
   ```bash
   cd contamination
   git init && git add . && git commit -m "Contamination"
   git branch -M main
   git remote add origin https://github.com/<your-username>/contamination.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages → Build and deployment**. Set Source to *Deploy from a branch*, Branch to `main`, folder `/ (root)`, then click **Save**.
4. After about a minute the page is live at `https://<your-username>.github.io/contamination/`.

The page loads three libraries from the jsDelivr CDN: UTIF.js (TIFF), pako (compressed TIFF) and SheetJS (Excel). It needs an internet connection the first time it's opened.

## Sharing the lab's ladders

Ladders you add or edit in **Manage ladder database** are saved in your browser only. To give everyone the same list:

1. In the app, open **Manage ladder database → Export JSON**.
2. Replace `lab-ladders.json` in the repository with the exported file and commit it.

Everyone who opens the page then gets those ladders preloaded. An entry with the same `id` as a built-in ladder replaces the built-in one.

## How the numbers are computed

| Step | Method |
|---|---|
| Wells / rows | Found from the comb imprints. A well is a slot lighter than the gel both sideways (narrower than a lane) and above/below (short), which rejects band gaps and smears. Rows are evenly spaced comb positions, and the first comb must sit above the first band row. Tilt comes from the imprints in the left and right thirds. |
| Lanes | Pitch from the column pattern, corrected by the imprint spacing. Lanes run from the first to the last visible imprint, and each lane is centred on its own well. |
| Ladder lanes | "Auto" uses ladder names in the label sheet, otherwise lanes with clearly more bands than a typical lane, in any position. Images over 12 MP are averaged down, with saturation judged at full resolution. |
| Lane profile | Mean signal across the central 60% of the lane width (adjustable), followed down the lane from the well, with tilt correction. |
| Background | Rolling minimum, then maximum, then a moving average (a 1-D "rolling ball"). The window is one lane pitch (adjustable). |
| Bands | Local maxima above 3× noise. Noise comes from the quiet part of the lane. |
| Ladder fit | Search over band↔size anchor pairs, refined with a quadratic, then scored on matched bands, missing bands, unexplained bands, fit error and bright-band agreement. Ladders of the same type on one gel are made consistent. Calibration is piecewise-linear log(bp) against distance. Two ladders in a row are interpolated by lane position. |
| Primer dimers | Discarded from calls and the product size, unless the expected size is below the cutoff (default 100 bp). A band is a dimer if (a) it sizes below the cutoff, or (b) it is the furthest-migrating band recurring across lanes, weaker than a product above it, and level with or below the ladder's lowest band (or small/fuzzy). Rule (b) works even when the ladder fit is wrong. The heavy dimer in no-template lanes is caught too. Dimers are still listed and drawn as grey dashed boxes. |
| Reference lane | Click a band, then "Use as reference lane". Every lane is then compared only on its band of the same size (± tolerance), and lanes without one show "—". |
| Volume | Sum of background-subtracted signal across the band × strip width, in arbitrary units. Only compare volumes within one image. |
| Saturation | Fraction of band pixels at the image's clipping value. Saturated bands under-report volume. |
