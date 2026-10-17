// SPDX-License-Identifier: GPL-3.0-only
// Read-only content:// access to the small files FilesBridge.shareText writes into the cache: a
// canonical .sloopsong, a one-song .sloopset, or any other generated share form. The receiving app
// gets a one-shot read grant from the chooser; nothing in the library is modified.
package app.consort;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.Locale;

public final class ShareProvider extends ContentProvider {
    public static final String AUTHORITY = "app.consort.share";
    private static final String DIR = "share";

    @Override
    public boolean onCreate() {
        return true;
    }

    private File fileFor(Uri uri) {
        if (getContext() == null) return null;
        String name = uri.getLastPathSegment();
        if (name == null) return null;
        name = name.replaceAll("[\\\\/:*?\"<>|\\r\\n\\t]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) return null;
        File dir = new File(getContext().getCacheDir(), DIR);
        File f = new File(dir, name);
        try {
            if (!f.getCanonicalPath().startsWith(dir.getCanonicalPath() + File.separator)) return null;
        } catch (Exception e) {
            return null;
        }
        return f;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        String[] cols = projection != null ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols);
        File f = fileFor(uri);
        if (f != null && f.isFile()) {
            Object[] row = new Object[cols.length];
            for (int i = 0; i < cols.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = f.getName();
                else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
                else row[i] = null;
            }
            c.addRow(row);
        }
        return c;
    }

    @Override
    public String getType(Uri uri) {
        File f = fileFor(uri);
        return f == null ? null : mime(f.getName());
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (mode != null && mode.contains("w")) throw new FileNotFoundException("read only");
        File f = fileFor(uri);
        if (f == null || !f.isFile()) throw new FileNotFoundException(uri.toString());
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    private static String mime(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".json") || n.endsWith(".sloopsong") || n.endsWith(".sloopset")) return "application/json";
        if (n.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }
}
