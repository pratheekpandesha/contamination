# Gel Lane Analyzer

A drag-and-drop web page for agarose gel images. It runs entirely in the browser, so images are never uploaded anywhere.

- **Ladder database**: NEB, Thermo GeneRuler, Invitrogen and Bioline ladders are preloaded. You can add or edit ladders in the app, and share them with the lab through `lab-ladders.json`.
- **Automatic rows and lanes**: rows are found from the wells of each comb, and lanes from the comb pitch. The gel size and comb (tooth count) presets help, and gel tilt is corrected.
- **Labels from Excel or CSV**: sample names are applied in lane order, including ladder lanes. Ladder lanes are recognised by name ("Ladder", "Marker", "L", "M").
- **Ladder sizing**: ladder bands are matched to the chosen ladder automatically. Bright reference bands are used, and all ladders on a gel are fitted consistently. Band sizes come from interpolating log(bp) against migration distance.
- **Present / faint / absent calls** at an expected band size (±tolerance), set globally, per row or per lane.
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

## Deploy on GitHub Pages (one time, about 2 minutes)

1. Create a new repository on GitHub, e.g. `gel-analyzer` (public, or private on a plan that allows Pages).
2. Upload the contents of this folder (`index.html`, `css/`, `js/`, `lab-ladders.json`, `sample-labels.csv`, `README.md`). Either drag them into the GitHub web page ("Add file → Upload files"), or from a terminal:
   ```bash
   cd gel-analyzer
   git init && git add . && git commit -m "Gel Lane Analyzer"
   git branch -M main
   git remote add origin https://github.com/<your-username>/gel-analyzer.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages → Build and deployment**. Set Source to *Deploy from a branch*, Branch to `main`, folder `/ (root)`, then click **Save**.
4. After about a minute the page is live at `https://<your-username>.github.io/gel-analyzer/`.

The page loads three libraries from the jsDelivr CDN: UTIF.js (TIFF), pako (compressed TIFF) and SheetJS (Excel). It needs an internet connection the first time it's opened.

## Sharing the lab's ladders

Ladders you add or edit in **Manage ladder database** are saved in your browser only. To give everyone the same list:

1. In the app, open **Manage ladder database → Export JSON**.
2. Replace `lab-ladders.json` in the repository with the exported file and commit it.

Everyone who opens the page then gets those ladders preloaded. An entry with the same `id` as a built-in ladder replaces the built-in one.

## How the numbers are computed

| Step | Method |
|---|---|
| Wells / rows | Row-averaged intensity, high-pass filtered. Wells show up as narrow stripes with the opposite polarity to the bands. Tilt comes from the left and right thirds of the gel. |
| Lanes | Lane pitch from the autocorrelation of column profiles, shared by every row (same comb). The lane extent is a consensus across rows, so empty lanes at the row ends are kept. |
| Lane profile | Mean signal across the central 60% of the lane width (adjustable), followed down the lane from the well, with tilt correction. |
| Background | Rolling minimum, then maximum, then a moving average (a 1-D "rolling ball"). The window is one lane pitch (adjustable). |
| Bands | Local maxima above 3× noise. Noise comes from the quiet part of the lane. |
| Ladder fit | Search over band↔size anchor pairs, refined with a quadratic, then scored on matched bands, missing bands, unexplained bands, fit error and bright-band agreement. Ladders of the same type on one gel are made consistent. Calibration is piecewise-linear log(bp) against distance. Two ladders in a row are interpolated by lane position. |
| Volume | Sum of background-subtracted signal across the band × strip width, in arbitrary units. Only compare volumes within one image. |
| Saturation | Fraction of band pixels at the image's clipping value. Saturated bands under-report volume. |
