/**
 * seed-sequences.js
 *
 * Populates Firestore with the canonical sequence + pack catalog sourced from
 * platform.html's hardcoded mock data. Run once (or whenever the catalog changes):
 *
 *   node scripts/seed-sequences.js
 *
 * Requires firebase-admin in scripts/node_modules (already installed).
 * Uses service-account.json in the Afterglo project root.
 */

const admin = require('firebase-admin');
const path  = require('path');
const fs    = require('fs');

// ─── Service account ────────────────────────────────────────────────────────
const saPath = path.join(__dirname, '..', 'service-account.json');
const altPath = path.join(__dirname, '..', 'afterglo-website-fbb89-firebase-adminsdk-fbsvc-c5db700ceb.json');

const resolvedSa = fs.existsSync(saPath) ? saPath : altPath;
if (!fs.existsSync(resolvedSa)) {
  console.error('ERROR: service account JSON not found at either expected path:');
  console.error('  ' + saPath);
  console.error('  ' + altPath);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(resolvedSa)),
  storageBucket: 'afterglo-website-fbb89.firebasestorage.app',
});

const db = admin.firestore();

// ─── Sequences ───────────────────────────────────────────────────────────────
// Sourced from the `sequences` array in platform.html (mock data section).
// Fields mapped to the canonical Firestore schema:
//   id, name, creator, category, durationSecs, price, isFree,
//   description, previewColors, channelCount, downloadCount, status
//
// duration "m:ss" is converted to durationSecs.
// gradient stop colors are extracted as previewColors hex strings.

function parseDuration(dur) {
  if (!dur) return 0;
  const parts = dur.split(':').map(Number);
  return parts.length === 2 ? parts[0] * 60 + parts[1] : 0;
}

const sequences = [
  {
    id: 'candy-cane-dream',
    name: 'Candy Cane Dream',
    creator: 'jwitchell',
    creatorUid: 'system',
    category: 'christmas',
    durationSecs: parseDuration('3:42'),
    channelCount: 1024,
    price: 0,
    isFree: true,
    description: 'Classic candy cane red-and-white chase pattern synced to holiday favourites.',
    previewColors: ['#c8000a', '#ffffff'],
    thumbnailGradient: 'linear-gradient(135deg, #c8000a 0%, #ffffff 50%, #c8000a 100%)',
    status: 'published',
    downloadCount: 412,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'star-spangled-roofline',
    name: 'Star-Spangled Roofline',
    creator: 'patriot_pixels',
    creatorUid: 'system',
    category: 'patriotic',
    durationSecs: parseDuration('4:18'),
    channelCount: 768,
    price: 9.98,
    isFree: false,
    description: 'Red, white, and blue wave sweeps across your roofline in true American style.',
    previewColors: ['#3c3b6e', '#b22234', '#ffffff'],
    thumbnailGradient: 'linear-gradient(135deg, #3c3b6e 0%, #b22234 50%, #ffffff 100%)',
    status: 'published',
    downloadCount: 287,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'spooky-strobe-free',
    name: 'Spooky Strobe-Free',
    creator: 'HauntMaster',
    creatorUid: 'system',
    category: 'halloween',
    durationSecs: parseDuration('2:55'),
    channelCount: 512,
    price: 0,
    isFree: true,
    description: 'Eerie orange and deep purple flicker effects — all the spook, none of the strobe.',
    previewColors: ['#1a0030', '#ff6600', '#000000'],
    thumbnailGradient: 'linear-gradient(135deg, #1a0030 0%, #ff6600 60%, #000000 100%)',
    status: 'published',
    downloadCount: 634,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'winter-wonderland-chase',
    name: 'Winter Wonderland Chase',
    creator: 'ShaneW_Lights',
    creatorUid: 'system',
    category: 'christmas',
    durationSecs: parseDuration('5:10'),
    channelCount: 2048,
    price: 13.98,
    isFree: false,
    description: 'Sweeping frost-blue and warm-gold chases that fill a 2048-channel roofline.',
    previewColors: ['#001a33', '#ffffff', '#D4A43A'],
    thumbnailGradient: 'linear-gradient(135deg, #001a33 0%, #ffffff 40%, #D4A43A 100%)',
    status: 'published',
    downloadCount: 198,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'firecracker-finale',
    name: 'Firecracker Finale',
    creator: 'UTpixels',
    creatorUid: 'system',
    category: 'fourth',
    durationSecs: parseDuration('6:02'),
    channelCount: 1536,
    price: 15.98,
    isFree: false,
    description: 'Six-minute grand finale with rapid-fire red, white, and blue burst effects.',
    previewColors: ['#ff0000', '#ffffff', '#0000cc'],
    thumbnailGradient: 'linear-gradient(135deg, #ff0000 0%, #ffffff 50%, #0000cc 100%)',
    status: 'published',
    downloadCount: 321,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'pumpkin-pulse',
    name: 'Pumpkin Pulse',
    creator: 'HauntMaster',
    creatorUid: 'system',
    category: 'halloween',
    durationSecs: parseDuration('3:28'),
    channelCount: 512,
    price: 0,
    isFree: true,
    description: 'Deep amber pulses and purple flickers for the perfect jack-o-lantern vibe.',
    previewColors: ['#2a0000', '#ff6600', '#3d0066'],
    thumbnailGradient: 'linear-gradient(135deg, #2a0000 0%, #ff6600 45%, #3d0066 100%)',
    status: 'published',
    downloadCount: 509,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'be-my-valentine',
    name: 'Be My Valentine',
    creator: 'HeartBeat_Shows',
    creatorUid: 'system',
    category: 'valentine',
    durationSecs: parseDuration('2:44'),
    channelCount: 640,
    price: 0,
    isFree: true,
    description: 'Soft pink and red heartbeat pulses for a romantic Valentine\'s display.',
    previewColors: ['#3d001a', '#ff1a6b', '#ffffff'],
    thumbnailGradient: 'linear-gradient(135deg, #3d001a 0%, #ff1a6b 50%, #ffffff 100%)',
    status: 'published',
    downloadCount: 183,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'northern-lights-effect',
    name: 'Northern Lights Effect',
    creator: 'AuroraCraft',
    creatorUid: 'system',
    category: 'christmas',
    durationSecs: parseDuration('4:55'),
    channelCount: 1024,
    price: 11.98,
    isFree: false,
    description: 'Aurora borealis-inspired greens and blues slowly sweep your roofline all night.',
    previewColors: ['#001a00', '#00ff88', '#0066ff'],
    thumbnailGradient: 'linear-gradient(135deg, #001a00 0%, #00ff88 40%, #0066ff 100%)',
    status: 'published',
    downloadCount: 445,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'freedom-waves',
    name: 'Freedom Waves',
    creator: 'patriot_pixels',
    creatorUid: 'system',
    category: 'patriotic',
    durationSecs: parseDuration('3:12'),
    channelCount: 768,
    price: 0,
    isFree: true,
    description: 'Free patriotic wave pattern looping seamlessly — perfect for Memorial Day or Veterans Day.',
    previewColors: ['#b22234', '#ffffff', '#3c3b6e'],
    thumbnailGradient: 'linear-gradient(135deg, #b22234 0%, #ffffff 35%, #3c3b6e 100%)',
    status: 'published',
    downloadCount: 267,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'twinkle-and-sparkle',
    name: 'Twinkle & Sparkle',
    creator: 'jwitchell',
    creatorUid: 'system',
    category: 'christmas',
    durationSecs: parseDuration('2:30'),
    channelCount: 256,
    price: 0,
    isFree: true,
    description: 'Simple, elegant random twinkle on warm white — a crowd favourite for minimalist displays.',
    previewColors: ['#0a001a', '#ffffff', '#D4A43A'],
    thumbnailGradient: 'linear-gradient(135deg, #0a001a 0%, #ffffff 50%, #D4A43A 100%)',
    status: 'published',
    downloadCount: 871,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'rockets-red-glare',
    name: "Rocket's Red Glare",
    creator: 'UTpixels',
    creatorUid: 'system',
    category: 'fourth',
    durationSecs: parseDuration('5:30'),
    channelCount: 1280,
    price: 9.98,
    isFree: false,
    description: 'Rapid red-and-yellow burst sequences that simulate a fireworks barrage overhead.',
    previewColors: ['#ff0000', '#ffff00'],
    thumbnailGradient: 'linear-gradient(135deg, #ff0000 0%, #ffff00 50%, #ff0000 100%)',
    status: 'published',
    downloadCount: 156,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'haunted-mansion-fade',
    name: 'Haunted Mansion Fade',
    creator: 'ShadowPixels',
    creatorUid: 'system',
    category: 'halloween',
    durationSecs: parseDuration('4:05'),
    channelCount: 896,
    price: 7.98,
    isFree: false,
    description: 'Slow deep-purple and crimson fades that drape your home in Gothic atmosphere.',
    previewColors: ['#0d0005', '#6600aa', '#1a0000'],
    thumbnailGradient: 'linear-gradient(135deg, #0d0005 0%, #6600aa 50%, #1a0000 100%)',
    status: 'published',
    downloadCount: 312,
    hasMp3: false,
    songName: '',
    youtubeUrl: '',
    createdAt: admin.firestore.Timestamp.now(),
  },
];

// ─── Packs ───────────────────────────────────────────────────────────────────
// Three themed bundles covering the main categories above.
// sequenceIds reference the `id` fields above.
// price is pre-calculated at ~20% off the sum of member sequence prices.

const packs = [
  {
    id: 'pack_christmas',
    name: 'Christmas Collection',
    description: 'Every Christmas sequence in one bundle — Candy Cane Dream, Winter Wonderland Chase, Northern Lights Effect, and Twinkle & Sparkle. Over 16 minutes of holiday magic.',
    sequenceIds: [
      'candy-cane-dream',
      'winter-wonderland-chase',
      'northern-lights-effect',
      'twinkle-and-sparkle',
    ],
    discount: 0.20,
    price: 20.77,   // (0 + 13.98 + 11.98 + 0) * 0.80 = 20.77
    bannerColor: '#C0392B',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'pack_halloween',
    name: 'Halloween Pack',
    description: 'Spine-chilling sequences to transform your house into the scariest on the block. Includes Spooky Strobe-Free, Pumpkin Pulse, and Haunted Mansion Fade.',
    sequenceIds: [
      'spooky-strobe-free',
      'pumpkin-pulse',
      'haunted-mansion-fade',
    ],
    discount: 0.20,
    price: 6.38,    // (0 + 0 + 7.98) * 0.80 = 6.38
    bannerColor: '#6C3483',
    createdAt: admin.firestore.Timestamp.now(),
  },
  {
    id: 'pack_patriotic',
    name: 'Patriotic Bundle',
    description: 'Red, white, and blue all year round. Perfect for 4th of July, Memorial Day, and Veterans Day. Includes Star-Spangled Roofline, Firecracker Finale, Freedom Waves, and Rocket\'s Red Glare.',
    sequenceIds: [
      'star-spangled-roofline',
      'firecracker-finale',
      'freedom-waves',
      'rockets-red-glare',
    ],
    discount: 0.20,
    price: 28.75,   // (9.98 + 15.98 + 0 + 9.98) * 0.80 = 28.75
    bannerColor: '#1F618D',
    createdAt: admin.firestore.Timestamp.now(),
  },
];

// ─── Seed ─────────────────────────────────────────────────────────────────────

async function seed() {
  console.log(`Using service account: ${resolvedSa}\n`);

  console.log('Seeding sequences...');
  for (const seq of sequences) {
    await db.collection('sequences').doc(seq.id).set(seq, { merge: true });
    console.log(`  + ${seq.name} (${seq.isFree ? 'free' : '$' + seq.price})`);
  }

  console.log('\nSeeding packs...');
  for (const pack of packs) {
    await db.collection('packs').doc(pack.id).set(pack, { merge: true });
    console.log(`  + ${pack.name} — $${pack.price} (${pack.discount * 100}% off)`);
  }

  console.log('\nDone. Run "firebase deploy --only functions" to expose the updated /getListings endpoint.');
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
