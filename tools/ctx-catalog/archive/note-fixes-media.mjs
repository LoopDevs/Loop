// Apply the user's review-note media fixes: explicit URL swaps + copy-from-sibling.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
const media = JSON.parse(readFileSync('/tmp/ctx-media-final.json', 'utf8'));
const fresh = JSON.parse(readFileSync('/tmp/ctx-fresh.json', 'utf8'));
const idByName = {};
for (const m of fresh) idByName[m.name] = m.id;
const id = (n) => idByName[n];

// [name, field('logo'|'cover'), url]
const URL = [
  [
    'American Express Prepaid - 12M Expiration',
    'logo',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/American_Express_logo_%282018%29.svg/250px-American_Express_logo_%282018%29.svg.png',
  ],
  [
    'American Express Prepaid - 12M Expiration',
    'cover',
    'https://a.storyblok.com/f/182663/800x418/c65f4645da/american_express_x.png/m/1200x630',
  ],
  [
    'American Express Prepaid - 6M Expiration',
    'logo',
    'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fa/American_Express_logo_%282018%29.svg/250px-American_Express_logo_%282018%29.svg.png',
  ],
  [
    'American Express Prepaid - 6M Expiration',
    'cover',
    'https://a.storyblok.com/f/182663/800x418/c65f4645da/american_express_x.png/m/1200x630',
  ],
  ['Argos', 'cover', 'https://c.files.bbci.co.uk/13F31/production/_89031718_hi031556833.jpg'],
  [
    'Beer52',
    'cover',
    'https://drinksretailingnews.co.uk/wp-content/uploads/2024/10/Beer52-Waitrose-4-pack-press-release-2.png?v=1730216733',
  ],
  [
    'Beer52 Craft Beer Club',
    'cover',
    'https://drinksretailingnews.co.uk/wp-content/uploads/2024/10/Beer52-Waitrose-4-pack-press-release-2.png?v=1730216733',
  ],
  [
    'Bonefish Grill',
    'cover',
    'https://www.tastingtable.com/img/gallery/10-popular-bonefish-grill-menu-items-ranked-worst-to-best/intro-1745616460.webp',
  ],
  [
    'Blue Dolphin Magazines',
    'cover',
    'https://support.bluedolphin-magazines.com/hc/theming_assets/01J6FH9QPPEQQG7XV2GYP26J7C',
  ],
  [
    'Blue Fin Seafood Sushi',
    'logo',
    'https://www.landrysinc.com/-/media/images/brands/landrysinc/logos/blue-fin_180-x-180.jpg?h=180&w=180&hash=CDA7969AC3010F8678476079590CAA99',
  ],
  [
    'Blue Fin Seafood Sushi',
    'cover',
    'https://www.landrysinc.com/-/media/images/brands/brand-detail/landrysinc/blue-fin/bluefin-sushi-grouping-1.png?as=0&w=1020&hash=E7B3466D1AEE9402A4BD6B9AA254B6DD',
  ],
  [
    'Bouchee Patisserie',
    'logo',
    'https://www.landrysinc.com/-/media/images/brands/landrysinc/logos/bouchee_180-x-180.jpg?h=180&w=180&hash=A7ADF4DD31447CA1F2FFAF8DBE593097',
  ],
  [
    'Bouchee Patisserie',
    'cover',
    'https://www.landrysinc.com/-/media/images/content/mastheads/landrysinc/bouchee-masthead.png?as=0&w=1440&hash=A95B1E56E4C4211A06701436DE3CDE7D',
  ],
  [
    'Buyagift',
    'cover',
    'https://res.dayoutwiththekids.co.uk/image/upload/c_fill%2Cq_auto%2Cw_1278%2Ch_718/v1595442212/attractions/g/go-ape-battersea-park-e92a9884/go-ape_kids_3.jpg',
  ],
  [
    'Caffè Nero',
    'logo',
    'https://images.hotukdeals.com/threads/raw/fNjAU/4752337_1/re/1024x1024/qt/60/4752337_1.jpg',
  ],
  ['Caffè Nero', 'cover', 'https://www.rushmereshopping.com/wp-content/uploads/2024/12/NERO.jpg'],
  [
    'Canteen',
    'cover',
    'https://cdn.oliverbonacininetwork.com/uploads/sites/21/2024/06/Tiff-Taco-Platter-Header.jpg',
  ],
  [
    'Carma - Champion',
    'logo',
    'https://accountexmanchester.com/wp-content/uploads/2023/06/Carma_Earth_logo-1.png',
  ],
  [
    'Carma - Hero',
    'logo',
    'https://accountexmanchester.com/wp-content/uploads/2023/06/Carma_Earth_logo-1.png',
  ],
  [
    'Carma - Plant a Tree',
    'logo',
    'https://accountexmanchester.com/wp-content/uploads/2023/06/Carma_Earth_logo-1.png',
  ],
  [
    'Carma - Warrior',
    'logo',
    'https://accountexmanchester.com/wp-content/uploads/2023/06/Carma_Earth_logo-1.png',
  ],
  ['Costa', 'cover', 'https://static.independent.co.uk/2025/08/28/15/35/costa-coffee.png'],
  [
    'Final Fantasy XIV - 60 Days',
    'logo',
    'https://imguscdn.gamespress.com/cdn/files/Square-Enix/2017/02/na-1-20170201030030/FFXIV_logo_20160810_600px.jpg?w=600&mode=max&otf=y&quality=90&format=jpg&bgcolor=white',
  ],
  [
    'Final Fantasy XIV - 60 Days',
    'cover',
    'https://image.api.playstation.com/vulcan/ap/rnd/202011/1012/jHGhX0hNB6jY2SQBXA5Z6YO5.jpg',
  ],
  [
    'Flexepin',
    'cover',
    'https://gamecardsdirect.com/content/item/nieuwsafb_banner/5440/flexepin.jpg',
  ],
  ['Google Play Canada', 'cover', 'https://cdn.mos.cms.futurecdn.net/5bGn34kesYNpYY8YDgL4E5.jpg'],
  ['Google Play UK', 'cover', 'https://cdn.mos.cms.futurecdn.net/5bGn34kesYNpYY8YDgL4E5.jpg'],
  ['Google Play US', 'cover', 'https://cdn.mos.cms.futurecdn.net/5bGn34kesYNpYY8YDgL4E5.jpg'],
  [
    'Greggs',
    'cover',
    'https://www.getintonewcastle.co.uk/images/uploads/js78980789-1464079493.jpg?w=950&fm=webp',
  ],
  [
    'Guess Canada',
    'logo',
    'https://i.pinimg.com/736x/09/d9/a8/09d9a8956c1bc668e5a96df0b6e4f216.jpg',
  ],
  ['Guess US', 'logo', 'https://i.pinimg.com/736x/09/d9/a8/09d9a8956c1bc668e5a96df0b6e4f216.jpg'],
  ['Guild Wars 2 - Gem Card', 'cover', 'https://images5.alphacoders.com/298/thumb-1920-298937.jpg'],
  [
    'Halfords',
    'cover',
    'https://amcdn.blob.core.windows.net/media/1/root/halfords-store-and-mobile-expert-van.jpg',
  ],
  [
    'Halfords Autocentres',
    'cover',
    'https://amcdn.blob.core.windows.net/media/1/root/halfords-store-and-mobile-expert-van.jpg',
  ],
  [
    "Fisherman's Wharf",
    'cover',
    'https://images.getbento.com/accounts/aaa83b863f9ed8cd5f7d1c5ae5f44565/media/images/83606FIWF_Maine_Lobster.jpg?w=1200&fit=crop&auto=compress,format&cs=origin&crop=focalpoint&fp-x=0.5&fp-y=0.15',
  ],
  [
    "Biff's Bistro",
    'logo',
    'https://cdn.oliverbonacininetwork.com/uploads/sites/19/2016/04/Biffs-Bistro-favicon.png',
  ],
  [
    "Biff's Bistro",
    'cover',
    'https://cdn.oliverbonacininetwork.com/uploads/sites/19/2024/08/DSC5996-1024x684.jpg',
  ],
  [
    'Canoe',
    'cover',
    'https://cdn.oliverbonacininetwork.com/uploads/sites/42/2022/04/Canoe-Tasting-Menu-2022-3532.jpg',
  ],
  [
    'Freshii',
    'cover',
    'https://dynamic-media-cdn.tripadvisor.com/media/photo-o/1b/b6/d6/93/freshii-favourites.jpg?w=900&h=500&s=1',
  ],
  [
    'Fast Fuel',
    'logo',
    'https://www.shopsatmissionhills.ca/wp-content/uploads/2021/12/mission-hills-store-fastfuel-550x550.png',
  ],
];

// [name, field, fromName] — copy a sibling's current image
const COPY = [
  ['Airbnb Canada', 'cover', 'Airbnb US'],
  ['Airbnb UK', 'cover', 'Airbnb US'],
  ['Blizzard US', 'cover', 'Blizzard Canada'],
  ['DoorDash DashPass - 6 Months', 'cover', 'DoorDash US'],
  ['dots.eco - Buy 10 sqft of Land for Nature Reserves', 'cover', 'dots.eco - Buy Land for Nature'],
  ['dots.eco - Fighting Wildfires', 'cover', 'dots.eco - Buy Land for Nature'],
  [
    'dots.eco - Offset 10 kg of Carbon Emissions',
    'cover',
    'dots.eco - Plant a Tree Where Needed the Most',
  ],
  [
    'dots.eco - Restore 1 Fragment of Coral Reef',
    'cover',
    'dots.eco - Protect 10 sqm of Marine Habitat',
  ],
  ['EA Play - 12 Months (Xbox)', 'cover', 'EA Play'],
  ['Fairmont Hotels & Resorts Canada', 'cover', 'Fairmont Hotels & Resorts US'],
  ['Grubhub US', 'cover', 'Grubhub UK'],
  ['Grubhub+ - 1 Month', 'cover', 'Grubhub UK'],
  ['Grubhub+ - 12 Months', 'cover', 'Grubhub UK'],
  ['Groupon Canada', 'logo', 'Groupon US'],
  ['Carma - Champion', 'cover', 'Carma - Plant a Tree'],
  ['Carma - Hero', 'cover', 'Carma - Plant a Tree'],
  ['Carma - Warrior', 'cover', 'Carma - Plant a Tree'],
];

const FIELD = { logo: 'logoUrl', cover: 'headerUrl' };
let u = 0,
  c = 0,
  miss = [];
for (const [name, field, url] of URL) {
  const i = id(name);
  if (!i || !media[i]) {
    miss.push(name);
    continue;
  }
  media[i][FIELD[field]] = url;
  media[i][field === 'logo' ? 'logoSource' : 'headerSource'] = 'user-note';
  u++;
}
for (const [name, field, from] of COPY) {
  const i = id(name),
    fi = id(from);
  if (!i || !media[i] || !fi || !media[fi]) {
    miss.push(name + '←' + from);
    continue;
  }
  const src = media[fi][FIELD[field]];
  if (!src) {
    miss.push(name + ' (source empty)');
    continue;
  }
  media[i][FIELD[field]] = src;
  media[i][field === 'logo' ? 'logoSource' : 'headerSource'] = 'user-note-copy';
  c++;
}
writeFileSync('/tmp/ctx-media-final.json', JSON.stringify(media, null, 2));
copyFileSync('/tmp/ctx-media-final.json', '/Users/ash/loop-media-work/ctx-media-final.json');
console.log(`URL swaps applied: ${u} | sibling copies: ${c}`);
if (miss.length) console.log('MISSES (name not found / empty source):', miss.join(' | '));
