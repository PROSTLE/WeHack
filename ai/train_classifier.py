import os
import random
import pickle
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.metrics import classification_report, accuracy_score

print("Generating enhanced synthetic dataset...")

categories = ['work', 'personal', 'media', 'code', 'archive', 'other']
data = []

def build_feature_text(extension, filename, content_snippet=''):
    """Build the combined feature text — MUST match classify_server.py exactly."""
    return f"{extension} {extension} {extension} {filename} {content_snippet}".lower().strip()

def add_samples(cat, extensions, filenames, text_snippets, count):
    exts = extensions.split()
    fnames = filenames.split('|')
    for _ in range(count):
        ext = random.choice(exts)
        fname = random.choice(fnames)
        # Add realistic filename variations: numbering, dates, prefixes
        suffix = random.choice(['', '_v2', '_final', '_2024', '_2025', '_draft', '_copy',
                                 '_01', '_02', '_backup', ''])
        fname_full = f"{fname}{suffix}.{ext}"
        text = random.choice(text_snippets)
        combined = build_feature_text(ext, fname_full, text)
        data.append({'text': combined, 'label': cat})

# ── WORK DOCUMENTS ──
# Very strong signal: extensions like pdf/docx/xlsx + business filenames
work_extensions = 'pdf docx xlsx pptx csv doc xls ppt'
work_filenames = (
    'invoice|report|budget|proposal|contract|agreement|meeting_minutes|project_plan|'
    'performance_review|statement|financial|payroll|memo|policy|audit|compliance|nda|sow|'
    'estimate|quotation|timesheet|purchase_order|expense_report|org_chart|risk_assessment|'
    'business_plan|balance_sheet|profit_loss|cash_flow|annual_report|board_minutes|'
    'work_schedule|salary_slip|offer_letter|resignation|appraisal|kpi|okr|roadmap|'
    'marketing_plan|sales_report|client_brief|scope_of_work|service_agreement|'
    'consulting_report|due_diligence|valuation|term_sheet|pitch_deck|investor_update'
)
work_snippets = [
    "q3 financial report analysis revenue expenses profit margin growth",
    "meeting minutes agenda action items deliverables timeline stakeholders",
    "invoice billing total amount due payment terms net thirty",
    "marketing strategy budget presentation quarterly business review",
    "contract agreement non-disclosure terms conditions clause effective date",
    "employee performance review HR policy objectives annual goals",
    "business proposal executive summary market research analysis competitive",
    "project plan milestone deliverable stakeholder risk mitigation schedule",
    "quarterly earnings per share dividends shareholders equity capital",
    "purchase order vendor supplier item quantity price approval",
    "expense report travel reimbursement meals lodging transportation",
    "payroll salary wages deductions tax withholding benefits compensation",
    "compliance regulations audit findings recommendations corrective action",
    "strategic planning initiative objectives key results cross-functional team",
    "sales pipeline forecast conversion rate lead generation customer acquisition",
    "budget allocation department cost center fiscal year operating expenses",
    "board resolution governance corporate minutes shareholders vote",
    "supply chain procurement logistics inventory management forecasting",
    "client presentation deliverables scope milestones timeline resources",
    "human resources recruitment hiring onboarding orientation training",
]
add_samples('work', work_extensions, work_filenames, work_snippets, 800)

# ── PERSONAL DOCUMENTS ──
personal_extensions = 'pdf txt docx jpg png'
personal_filenames = (
    'itinerary|boarding_pass|receipt|tax_return|grocery_list|journal|diary|wedding|lease|'
    'medical|prescription|insurance|passport|visa|certificate|reservation|ticket|'
    'resume|cv|cover_letter|birth_certificate|death_certificate|marriage_certificate|'
    'vaccination|immunization|dental|veterinary|pet|recipe|cookbook|letter|postcard|'
    'will|testament|deed|mortgage|loan|bank_statement|credit_card|401k|ira|'
    'workout|fitness|meal_plan|shopping_list|wish_list|bucket_list|travel_plan|'
    'school_records|transcript|diploma|report_card|homework|notes|study_guide'
)
personal_snippets = [
    "flight itinerary boarding pass booking confirmation departure arrival",
    "tax return w2 form 1040 internal revenue service irs deduction",
    "gym receipt grocery list personal items household shopping",
    "journal entry thoughts feelings personal reflection notes today",
    "wedding planning guest list invitations venue catering flowers",
    "rental lease landlord tenant apartment deposit monthly rent",
    "medical records doctor prescription health insurance claim diagnosis",
    "passport renewal application visa immigration travel documents",
    "birthday party invitation celebration anniversary personal event",
    "dentist appointment cleaning checkup xray cavity filling",
    "car insurance policy premium deductible coverage auto home",
    "resume education experience skills employment history references",
    "cover letter application position hiring manager dear sir madam",
    "bank statement savings checking balance transactions deposits withdrawals",
    "mortgage application loan approval interest rate monthly payment",
    "recipe cooking baking ingredients instructions preparation dinner lunch",
    "vacation photos travel memories family friends sightseeing tour",
    "personal budget monthly expenses income savings emergency fund",
    "school homework assignment essay project presentation due date",
    "love letter personal correspondence thank you note greeting",
]
add_samples('personal', personal_extensions, personal_filenames, personal_snippets, 700)

# ── MEDIA FILES ──
media_extensions = 'jpg jpeg png gif mp4 mp3 wav mkv avi mov webm flac bmp svg tiff webp aac ogg m4a m4v wmv'
media_filenames = (
    'IMG|DSC|photo|DCIM|video|clip|recording|album|track|screenshot|wallpaper|podcast|'
    'movie|episode|music|song|thumbnail|banner|cover|poster|portrait|landscape|selfie|'
    'panorama|timelapse|slowmo|burst|live_photo|screen_recording|voice_memo|ringtone|'
    'artwork|illustration|render|animation|trailer|teaser|vlog|stream|highlight|montage|'
    'PXL|VID|MVI|GOPR|DJI|scan|capture|snap|pic|frame|shot|take|raw|edit|final_cut'
)
media_snippets = [
    "image jpeg exif camera lens aperture iso shutter speed focal length",
    "video mp4 duration bitrate framerate codec resolution 1080p 4k",
    "audio mp3 wav album artist track metadata lossless bitrate",
    "photograph vacation trip family portrait landscape sunset beach",
    "png transparent background graphic design logo icon illustration",
    "raw cr2 dng adobe lightroom photography post processing develop",
    "screenshot wallpaper desktop background mobile screen capture",
    "podcast episode recording broadcast interview show host guest",
    "music playlist genre artist album title track number lyrics",
    "movie film cinema reel scene director actor actress",
    "animation render frame keyframe timeline blender after effects",
    "drone aerial footage landscape overhead view bird eye",
    "gopro action camera wide angle fisheye adventure extreme sports",
    "timelapse sunset sunrise clouds sky stars astrophotography",
    "voice memo recording dictation speech note audio personal",
    "thumbnail preview preview image small resolution web",
    "concert live performance stage band crowd audience festival",
    "selfie front camera mirror reflection portrait face",
    "nature wildlife animal bird tree forest mountain river lake",
    "wedding photos ceremony reception bride groom celebration party",
]
add_samples('media', media_extensions, media_filenames, media_snippets, 800)

# ── CODE / DEVELOPMENT ──
code_extensions = 'js ts py java c cpp cs go rb html css json xml md sh yaml toml rs swift kt php sql vue jsx tsx scss less bat ps1 r m ipynb'
code_filenames = (
    'main|index|app|server|utils|helpers|component|service|controller|model|config|'
    'webpack|package|setup|Makefile|Dockerfile|requirements|README|LICENSE|CHANGELOG|'
    'test|spec|middleware|router|handler|factory|builder|adapter|decorator|observer|'
    'database|migration|seed|schema|query|api|endpoint|route|auth|login|register|'
    'logger|validator|serializer|parser|compiler|transpiler|bundler|loader|plugin|'
    'cli|command|task|job|worker|queue|consumer|producer|subscriber|publisher|'
    'gitignore|editorconfig|eslintrc|tsconfig|jest.config|vite.config|next.config|'
    'constants|types|interfaces|enums|errors|exceptions|hooks|context|store|reducer'
)
code_snippets = [
    "import react components props useState useEffect render jsx",
    "function main return void public static class interface abstract",
    "const let var async await promise callback request response",
    "def __init__ self import sys os subprocess json argparse",
    "git commit push pull branch merge rebase cherry-pick stash",
    "dockerfile from ubuntu run apt-get install expose cmd entrypoint",
    "html body div class style script stylesheet link meta head",
    "api endpoint REST fetch axios request response middleware cors",
    "test spec assert mock jest pytest unit integration coverage",
    "sql select from where join group by order having insert update",
    "class constructor method property getter setter override extends",
    "try catch throw exception error handling finally cleanup",
    "npm install package dependency devDependency scripts start build",
    "algorithm sort search binary tree graph hash map set queue stack",
    "type interface enum generic template typedef struct union",
    "lambda arrow closure higher-order map filter reduce foreach",
    "regex pattern match capture group replace split expression",
    "debug breakpoint console log print trace step inspect variable",
    "deployment ci cd pipeline github actions workflow yaml trigger",
    "kubernetes docker container pod service ingress namespace helm",
]
add_samples('code', code_extensions, code_filenames, code_snippets, 800)

# ── ARCHIVES ──
archive_extensions = 'zip rar 7z tar gz bz2 xz tgz tar.gz tar.bz2 tar.xz z lz4 zst cab iso dmg img'
archive_filenames = (
    'backup|archive|compressed|bundle|release|dist|package|export|snapshot|dump|'
    'download|collection|data_export|site_backup|db_dump|full_backup|incremental|'
    'project_archive|source_code|assets|media_bundle|migration|transfer|delivery|'
    'build|artifact|deployment|distribution|installer|portable|offline|pack'
)
archive_snippets = [
    "zip archive compressed tar gz extracted bytes ratio compression",
    "rar 7z compression packed files folders winrar unzip extract",
    "backup dump restore tarball full incremental differential snapshot",
    "release bundle distribution package artifact versioned deploy",
    "export snapshot data migration compressed transfer archive",
    "disk image iso dmg installer bootable mounted volume partition",
    "compressed folder multiple files directories nested tree structure",
    "download collection batch bulk aggregate combined merged packed",
    "database dump sql backup restoration recovery point-in-time",
    "project archive source code assets resources bundled together",
    "deployment package artifact build output compiled minified optimized",
    "portable installation offline standalone self-contained application",
    "data export csv json xml bulk records rows entries",
    "site backup wordpress drupal joomla cms full backup restore",
    "media bundle photos videos audio files compressed transferred",
]
add_samples('archive', archive_extensions, archive_filenames, archive_snippets, 500)

# ── OTHER / SYSTEM / BINARY ──
other_extensions = 'bin exe dll tmp dat db sqlite log cfg ini sys drv inf plist reg com scr ocx so dylib a o obj lib'
other_filenames = (
    'temp|cache|lock|core|crash|system|runtime|lib|obj|out|build|debug|release|'
    '.DS_Store|Thumbs|desktop|ntuser|hiberfil|pagefile|swapfile|kernel|driver|'
    'preferences|settings|profile|registry|manifest|signature|certificate|token|'
    'session|cookie|pid|socket|pipe|fifo|device|firmware|bios|uefi|bootloader'
)
other_snippets = [
    "unknown binary format hex dump executable machine code bytecode",
    "tmp temporary cache file swp locked swap intermediate scratch",
    "application executable dll library runtime dependency shared object",
    "system config profile environment variables bash zsh shell rc",
    "log output debug trace error warning info critical fatal stacktrace",
    "database sqlite db file records table index query pragma journal",
    "crash report core dump segfault stack overflow memory violation",
    "registry key value hive regedit windows system configuration",
    "firmware update flash bios uefi embedded microcontroller rom",
    "device driver kernel module loadable hardware interface io",
    "certificate key pem crt private public ssl tls x509 chain",
    "session token cookie authentication state persistence browser",
    "lock file mutex semaphore process synchronization concurrent",
    "preferences user settings defaults options flags toggles",
    "pipe socket ipc inter-process communication fifo named descriptor",
]
add_samples('other', other_extensions, other_filenames, other_snippets, 500)

# ── Add extension-only samples for strong extension signal ──
print("Adding extension-focused samples...")
extension_map = {
    'work': 'pdf docx xlsx pptx csv doc xls ppt'.split(),
    'personal': 'pdf txt docx'.split(),
    'media': 'jpg jpeg png gif mp4 mp3 wav mkv avi mov webm flac bmp svg tiff webp aac ogg m4a'.split(),
    'code': 'js ts py java c cpp cs go rb html css json xml sh yaml toml rs swift kt php sql vue jsx tsx scss'.split(),
    'archive': 'zip rar 7z tar gz bz2 xz tgz iso dmg'.split(),
    'other': 'bin exe dll tmp dat db sqlite log cfg ini sys so dylib'.split(),
}

for cat, exts in extension_map.items():
    for ext in exts:
        # Pure extension-only samples to strengthen extension signal
        for _ in range(15):
            text = build_feature_text(ext, f"file.{ext}", "")
            data.append({'text': text, 'label': cat})
        # Extension with random generic filename
        generic_names = ['document', 'file', 'data', 'untitled', 'new', 'download', 'output', 'result']
        for _ in range(10):
            name = random.choice(generic_names)
            text = build_feature_text(ext, f"{name}.{ext}", "")
            data.append({'text': text, 'label': cat})

# Note: pdf appears in both 'work' and 'personal' — that's fine,
# the filename + content will disambiguate

df = pd.DataFrame(data)
random.seed(42)
df = df.sample(frac=1, random_state=42).reset_index(drop=True)
print(f"Dataset size: {len(df)} samples")
print(f"Distribution:\n{df['label'].value_counts().to_string()}")

X_train, X_test, y_train, y_test = train_test_split(
    df['text'], df['label'], test_size=0.2, random_state=42, stratify=df['label']
)

print("\nTraining TF-IDF + GradientBoosting Pipeline...")
pipeline = Pipeline([
    ('tfidf', TfidfVectorizer(
        max_features=5000,
        ngram_range=(1, 3),
        sublinear_tf=True,
        analyzer='word',
        min_df=2,
    )),
    ('clf', GradientBoostingClassifier(
        n_estimators=300,
        max_depth=6,
        learning_rate=0.1,
        subsample=0.8,
        random_state=42,
    ))
])

pipeline.fit(X_train, y_train)

# ── Evaluate ──
y_pred = pipeline.predict(X_test)
accuracy = accuracy_score(y_test, y_pred)
print(f"\n✅ Test Accuracy: {accuracy:.4f}")
print(f"\nClassification Report:\n{classification_report(y_test, y_pred)}")

# Cross-validation for robustness
print("Running 5-fold cross-validation...")
cv_scores = cross_val_score(pipeline, df['text'], df['label'], cv=5, scoring='accuracy')
print(f"CV Accuracy: {cv_scores.mean():.4f} ± {cv_scores.std():.4f}")

# ── Save ──
model_path = os.path.join(os.path.dirname(__file__), 'model.pkl')
with open(model_path, 'wb') as f:
    pickle.dump(pipeline, f)
print(f"\nModel saved to: {model_path}")
print("Done! 🚀")
