/* Built-in ladder database.
 * sizes  : every band in bp (any order)
 * bright : reference bands that are visibly brighter (helps auto-assignment; optional)
 * Values are from the manufacturers' published datasheets — check against the lot you use
 * and edit in the app (Manage ladders) or add your lab's ladders to lab-ladders.json.
 */
window.BUILTIN_LADDERS = [
  { id: 'neb-100bp', name: 'NEB 100 bp DNA Ladder', catalog: 'N3231',
    sizes: [1517, 1200, 1000, 900, 800, 700, 600, 517, 500, 400, 300, 200, 100], bright: [1000, 517, 500] },
  { id: 'neb-1kb', name: 'NEB 1 kb DNA Ladder', catalog: 'N3232',
    sizes: [10002, 8001, 6001, 5001, 4001, 3001, 2000, 1500, 1000, 517, 500], bright: [3001] },
  { id: 'neb-1kb-plus', name: 'NEB 1 kb Plus DNA Ladder', catalog: 'N3200',
    sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100], bright: [3000, 1000, 500] },
  { id: 'neb-50bp', name: 'NEB 50 bp DNA Ladder', catalog: 'N3236',
    sizes: [1350, 916, 766, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100, 50], bright: [350] },
  { id: 'neb-lmw', name: 'NEB Low Molecular Weight Ladder', catalog: 'N3233',
    sizes: [766, 500, 350, 300, 250, 200, 150, 100, 75, 50, 25], bright: [] },
  { id: 'neb-quick-1kb-ext', name: 'NEB 1 kb Extend DNA Ladder', catalog: 'N3239',
    sizes: [48500, 20000, 15000, 10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500], bright: [3000] },
  { id: 'tf-generuler-1kb', name: 'Thermo GeneRuler 1 kb', catalog: 'SM0311',
    sizes: [10000, 8000, 6000, 5000, 4000, 3500, 3000, 2500, 2000, 1500, 1000, 750, 500, 250], bright: [6000, 3000, 1000] },
  { id: 'tf-generuler-1kb-plus', name: 'Thermo GeneRuler 1 kb Plus', catalog: 'SM1331',
    sizes: [20000, 10000, 7000, 5000, 4000, 3000, 2000, 1500, 1000, 700, 500, 400, 300, 200, 75], bright: [5000, 1500, 500] },
  { id: 'tf-generuler-100bp-plus', name: 'Thermo GeneRuler 100 bp Plus', catalog: 'SM0321',
    sizes: [3000, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 500, 400, 300, 200, 100], bright: [1000, 500] },
  { id: 'tf-generuler-100bp', name: 'Thermo GeneRuler 100 bp', catalog: 'SM0241',
    sizes: [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100], bright: [500] },
  { id: 'tf-generuler-50bp', name: 'Thermo GeneRuler 50 bp', catalog: 'SM0371',
    sizes: [1000, 900, 800, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50], bright: [250] },
  { id: 'tf-generuler-ultra-low', name: 'Thermo GeneRuler Ultra Low Range', catalog: 'SM1211',
    sizes: [300, 200, 150, 100, 75, 50, 35, 25, 20, 15, 10], bright: [50] },
  { id: 'inv-1kb-plus', name: 'Invitrogen 1 Kb Plus DNA Ladder', catalog: '10787018',
    sizes: [15000, 10000, 8000, 7000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 850, 650, 500, 400, 300, 200, 100], bright: [1500] },
  { id: 'bioline-hyper-1kb', name: 'Bioline HyperLadder 1kb', catalog: 'BIO-33053',
    sizes: [10000, 8000, 6000, 5000, 4000, 3000, 2500, 2000, 1500, 1000, 800, 600, 400, 200], bright: [10000, 1000] },
  { id: 'bioline-hyper-100bp', name: 'Bioline HyperLadder 100bp', catalog: 'BIO-33056',
    sizes: [1013, 900, 800, 700, 600, 500, 400, 300, 200, 100], bright: [500] }
];
