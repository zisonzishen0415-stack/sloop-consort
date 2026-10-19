// SPDX-License-Identifier: GPL-3.0-only
// SLOOP's web editor in a WebView, with the FM-1 reached through Android's own USB MIDI (MidiBridge) instead of
// Web MIDI: no Chrome version to depend on, no network, nothing to install from a page.
package app.consort;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.midi.MidiManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

public class MainActivity extends Activity {
    private static final String TAG = "Sloop";
    private static final int PICK_FILE = 1001;
    private static final int MIC_FOR_WEB = 1002;
    private WebView web;
    private LocalServer server;
    private ValueCallback<Uri[]> filePathCallback;
    private PermissionRequest pendingMic;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        web.setWebViewClient(new WebViewClient() {
            // The app is served from 127.0.0.1; attribution/MIDIWeb links should leave the WebView
            // and open in the system browser instead of replacing Consort.
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme();
                if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return false;
                String host = uri.getHost();
                if ("127.0.0.1".equals(host) || "localhost".equals(host)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                } catch (ActivityNotFoundException e) {
                    return false;
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }

            // The LIVE tab records through getUserMedia; a WebView denies it unless the app grants it.
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean audio = false;
                for (String r : request.getResources())
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) audio = true;
                final boolean wantsAudio = audio;
                runOnUiThread(() -> {
                    if (!wantsAudio) {
                        request.deny();
                    } else if (checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                            == PackageManager.PERMISSION_GRANTED) {
                        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        pendingMic = request;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MIC_FOR_WEB);
                    }
                });
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = cb;
                try {
                    startActivityForResult(params.createIntent(), PICK_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });
        MidiManager mm = (MidiManager) getSystemService(Context.MIDI_SERVICE);
        web.addJavascriptInterface(new MidiBridge(web, mm), "ConsortMidi");
        web.addJavascriptInterface(new FilesBridge(this), "ConsortFiles");

        try {
            server = new LocalServer(this);
            web.loadUrl("http://127.0.0.1:" + server.port() + "/index.html");
        } catch (Exception e) {
            Log.e(TAG, "local server", e);
            web.loadData("<h3>SLOOP</h3><p>" + e + "</p>", "text/html", "utf-8");
        }

        // The editor fills the screen; the page carries the 工程文件 link in its device card (assets/midi-shim.js).
        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(0xFF000000);
        frame.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        // Android 15+ draws edge to edge; pad the frame itself, so the page starts below the status bar
        // (padding a WebView for insets does not take effect).
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            int l, t, r, b;
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(
                        android.view.WindowInsets.Type.systemBars()
                                | android.view.WindowInsets.Type.displayCutout());
                l = bars.left;
                t = bars.top;
                r = bars.right;
                b = bars.bottom;
            } else {
                l = insets.getSystemWindowInsetLeft();
                t = insets.getSystemWindowInsetTop();
                r = insets.getSystemWindowInsetRight();
                b = insets.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, b);
            return insets;
        });
        setContentView(frame);
    }

    @Override
    protected void onDestroy() {
        if (server != null) server.close();
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MIC_FOR_WEB || pendingMic == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (ok) pendingMic.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else pendingMic.deny();
        pendingMic = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != PICK_FILE) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {                 // "select several" (libraries, sample folders)
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(result);
            filePathCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

}
