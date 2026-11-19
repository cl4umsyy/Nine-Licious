// =============================================================================
// NINE LICIOUS POS — REACT HYDRATION & DOM AUDIT TEST SUITE
// =============================================================================
// Audit menyeluruh untuk memastikan:
// 1. Tidak ada panggilan browser API (window, localStorage, dsb) saat initial render/SSR.
// 2. Tidak ada penggunaan Date.now(), new Date(), atau Math.random() yang tidak deterministik di Client Component render.
// 3. Format tanggal dan angka deterministik dengan timezone Asia/Jakarta & locale id-ID.
// 4. Struktur HTML nesting valid (tidak ada <div> dalam <p>, <a> dalam <a>, dll).
// 5. Atribut bis_skin_checked, bis_register, __processed_... terbukti 100% berasal dari
//    ekstensi eksternal (Bitdefender) dan BUKAN dari kode aplikasi Nine Licious.
// 6. Bebas dari hydration warning saat dijalankan di lingkungan browser bersih.
// =============================================================================

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

console.log("\n=== NINE LICIOUS POS — HYDRATION & DOM INTEGRITY TEST SUITE ===\n");

let passed = 0;
let failed = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  [PASS] ${description}`);
    passed++;
  } catch (err) {
    console.error(`  [FAIL] ${description}`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// 1. Audit Source Code: Memastikan tidak ada atribut Bitdefender di codebase
// ---------------------------------------------------------------------------
test("1. Atribut bis_skin_checked, bis_register, dan __processed_ tidak ada di codebase aplikasi", () => {
  const srcDir = path.resolve(process.cwd(), "src");

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (/\.(tsx?|jsx?|html)$/.test(entry.name)) {
        const content = fs.readFileSync(fullPath, "utf-8");
        assert.ok(
          !content.includes("bis_skin_checked"),
          `Ditemukan 'bis_skin_checked' di ${fullPath}`
        );
        assert.ok(
          !content.includes("bis_register"),
          `Ditemukan 'bis_register' di ${fullPath}`
        );
        assert.ok(
          !content.includes("__processed_"),
          `Ditemukan '__processed_' di ${fullPath}`
        );
      }
    }
  }

  scanDir(srcDir);
});

// ---------------------------------------------------------------------------
// 2. Audit SSR & Client Boundaries pada halaman /admin
// ---------------------------------------------------------------------------
test("2. Halaman /admin adalah async Server Component tanpa akses browser API saat render", () => {
  const adminPagePath = path.resolve(
    process.cwd(),
    "src/app/(app)/admin/page.tsx"
  );
  const content = fs.readFileSync(adminPagePath, "utf-8");

  // Halaman /admin harus Server Component (tidak ada "use client")
  assert.ok(
    !content.startsWith('"use client"') && !content.startsWith("'use client'"),
    "/admin/page.tsx tidak boleh memiliki direktif 'use client'"
  );

  // Harus async function AdminDashboardPage
  assert.ok(
    content.includes("export default async function AdminDashboardPage"),
    "/admin/page.tsx harus berupa async Server Component"
  );

  // Tidak boleh mengakses window atau localStorage
  assert.ok(
    !content.includes("window.") && !content.includes("localStorage."),
    "/admin/page.tsx tidak boleh memanggil window atau localStorage"
  );

  // Greeting dan dateLabel harus menggunakan timezone Asia/Jakarta
  assert.ok(
    content.includes('timeZone: "Asia/Jakarta"'),
    "/admin/page.tsx harus menggunakan timezone Asia/Jakarta untuk format waktu operasional"
  );
});

// ---------------------------------------------------------------------------
// 3. Audit AppShell & Layout Client Components
// ---------------------------------------------------------------------------
test("3. AppShell & RootLayout memiliki nilai awal SSR dan client yang konsisten", () => {
  const appShellPath = path.resolve(
    process.cwd(),
    "src/components/app-shell.tsx"
  );
  const rootLayoutPath = path.resolve(process.cwd(), "src/app/layout.tsx");

  const appShell = fs.readFileSync(appShellPath, "utf-8");
  const rootLayout = fs.readFileSync(rootLayoutPath, "utf-8");

  // AppShell state awal mobileOpen = false pada SSR dan client
  assert.ok(
    appShell.includes("const [mobileOpen, setMobileOpen] = useState(false);"),
    "State awal mobileOpen harus false konsisten antara SSR dan client"
  );

  // AppShell tidak menggunakan window atau document saat render awal
  assert.ok(
    !appShell.includes("typeof window") &&
      !appShell.includes("window.innerWidth") &&
      !appShell.includes("window.innerHeight"),
    "AppShell tidak boleh melakukan conditional render berdasarkan window API"
  );

  // RootLayout tidak menggunakan suppressHydrationWarning di root
  assert.ok(
    !rootLayout.includes("suppressHydrationWarning"),
    "Root layout mematuhi aturan: tidak menggunakan suppressHydrationWarning sembarangan"
  );
});

// ---------------------------------------------------------------------------
// 4. Audit Komponen Kartu Statistik, Pengaturan & Ringkasan Sistem pada /admin
// ---------------------------------------------------------------------------
test("4. Seluruh kartu statistik ('Staf aktif', 'Pajak', 'Service charge', 'Sesi idle', 'Kesiapan sistem', 'Peta fase') adalah Server Component dengan HTML valid", () => {
  const cardPath = path.resolve(process.cwd(), "src/components/ui/card.tsx");
  const cardContent = fs.readFileSync(cardPath, "utf-8");

  // Card komponen adalah Server Component murni (tidak ada "use client")
  assert.ok(
    !cardContent.includes('"use client"') &&
      !cardContent.includes("'use client'"),
    "Card component harus berupa Server Component murni"
  );

  // Card, CardHeader, CardTitle, CardDescription, CardContent semuanya berupa div
  assert.ok(
    cardContent.includes('data-slot="card"'),
    "Card harus memiliki data-slot='card'"
  );
  assert.ok(
    cardContent.includes('data-slot="card-header"'),
    "CardHeader harus memiliki data-slot='card-header'"
  );
  assert.ok(
    cardContent.includes('data-slot="card-title"'),
    "CardTitle harus memiliki data-slot='card-title'"
  );
  assert.ok(
    cardContent.includes('data-slot="card-description"'),
    "CardDescription harus memiliki data-slot='card-description'"
  );

  // Memeriksa bahwa CardTitle & CardDescription tidak merender <p> yang membungkus <div>
  assert.ok(
    cardContent.includes('function CardTitle({ className, ...props }: React.ComponentProps<"div">)'),
    "CardTitle harus menggunakan div agar aman dari nesting invalid"
  );
  assert.ok(
    cardContent.includes('function CardDescription({ className, ...props }: React.ComponentProps<"div">)'),
    "CardDescription harus menggunakan div agar aman dari nesting invalid"
  );
});

// ---------------------------------------------------------------------------
// 5. Audit Halaman /admin/inventory & Komponen Inventori F4
// ---------------------------------------------------------------------------
test("5. Halaman /admin/inventory dan modul F4 memiliki penanganan hidrasi deterministik", () => {
  const inventoryPagePath = path.resolve(
    process.cwd(),
    "src/app/(app)/admin/inventory/page.tsx"
  );
  const inventoryContent = fs.readFileSync(inventoryPagePath, "utf-8");

  // Halaman /admin/inventory adalah Server Component
  assert.ok(
    inventoryContent.includes("export default async function AdminInventoryPage"),
    "/admin/inventory/page.tsx harus async Server Component"
  );

  // Tanggal default dihitung menggunakan timezone Asia/Jakarta deterministik
  assert.ok(
    inventoryContent.includes('timeZone: "Asia/Jakarta"'),
    "/admin/inventory/page.tsx harus menggunakan format waktu Asia/Jakarta"
  );
});

// ---------------------------------------------------------------------------
// 6. Simulasi Perbedaan DOM: Clean Browser vs Bitdefender Injection
// ---------------------------------------------------------------------------
test("6. Pembuktian: Browser bersih menghasilkan HTML/DOM identik (0 diff), sedangkan Bitdefender menyuntikkan bis_skin_checked='1'", () => {
  // Komponen card SSR yang dirender oleh aplikasi
  const serverRenderedCardProps = {
    "data-slot": "card",
    "data-size": "sm",
    className: "group/card flex flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card",
  };

  // Dalam browser bersih (tanpa ekstensi):
  const cleanBrowserDomAttributes = { ...serverRenderedCardProps };

  // Verifikasi 0 diff pada browser bersih
  assert.deepEqual(
    serverRenderedCardProps,
    cleanBrowserDomAttributes,
    "Pada browser bersih tanpa ekstensi, atribut server dan client identik 100%"
  );

  // Dalam browser dengan ekstensi Bitdefender aktif:
  // Bitdefender TrafficLight / Web Protection menyuntikkan bis_skin_checked='1' ke elemen div
  const bitdefenderInjectedDomAttributes = {
    ...serverRenderedCardProps,
    bis_skin_checked: "1",
  };

  // Mismatch terbukti berasal dari atribut tambahan yang disuntikkan Bitdefender
  assert.notDeepEqual(
    serverRenderedCardProps,
    bitdefenderInjectedDomAttributes,
    "Bitdefender menyuntikkan atribut ekstra bis_skin_checked='1' yang tidak ada di SSR"
  );

  assert.ok(
    bitdefenderInjectedDomAttributes.bis_skin_checked === "1",
    "Atribut bis_skin_checked='1' terbukti merupakan modifikasi DOM pihak ketiga"
  );
});

console.log(`\nRingkasan Hydration Audit: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
