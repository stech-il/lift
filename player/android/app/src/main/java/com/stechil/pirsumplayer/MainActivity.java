package com.stechil.pirsumplayer;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.appcompat.app.AlertDialog;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

/**
 * נגן מסכים: מסך מלא / קיוסק, מסך דולק; אשף הרשאות סוללה והפעלה ברקע.
 * IndexedDB והמטמון ב-WebView — ללא שינוי ב-JS (אותו renderer כמו דסקטופ).
 */
public class MainActivity extends BridgeActivity {

  private static final String PREFS = "pirsum_android_setup";
  private static final String KEY_SETUP_DONE = "setup_wizard_done";
  /** כמו רקע body ב־CSS — החלון; WebView שקוף כדי למנוע מסך שחור לעיתים (שכבת GPU ב־WebView) */
  private static final int PLAYER_BG = 0xFF0A0E14;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    getWindow().setBackgroundDrawable(new ColorDrawable(PLAYER_BG));
    applyKioskWindowFlags();
    getWindow().getDecorView().post(this::applyWebViewBackground);
    getWindow().getDecorView().postDelayed(this::applyWebViewBackground, 400);
    getWindow().getDecorView().postDelayed(this::refreshWebViewLayout, 80);
    getWindow().getDecorView().postDelayed(this::refreshWebViewLayout, 450);
    if (savedInstanceState == null) {
      getWindow().getDecorView().post(this::maybeShowSetupWizard);
    }
  }

  @Override
  public void onResume() {
    super.onResume();
    getWindow().getDecorView().post(this::applyWebViewBackground);
    getWindow().getDecorView().post(this::refreshWebViewLayout);
    getWindow().getDecorView().postDelayed(this::refreshWebViewLayout, 120);
  }

  private void applyWebViewBackground() {
    try {
      Bridge b = getBridge();
      if (b == null) {
        return;
      }
      WebView wv = b.getWebView();
      if (wv != null) {
        wv.setBackgroundColor(Color.TRANSPARENT);
      }
    } catch (Throwable ignored) {
    }
  }

  /** מסך שחור לעיתים אחרי עליה/חזרה לחלון — מאלץ ציור מחדש ב־WebView */
  private void refreshWebViewLayout() {
    try {
      Bridge b = getBridge();
      if (b == null) {
        return;
      }
      WebView wv = b.getWebView();
      if (wv == null) {
        return;
      }
      wv.invalidate();
      wv.requestLayout();
    } catch (Throwable ignored) {
    }
  }

  @Override
  public void onWindowFocusChanged(boolean hasFocus) {
    super.onWindowFocusChanged(hasFocus);
    if (hasFocus) {
      applyKioskWindowFlags();
      applyWebViewBackground();
    }
  }

  /** מסך מלא, הסתרת סרגלי מערכת, מסך נשאר דולק (מתאים לטאבלט בשירות). */
  private void applyKioskWindowFlags() {
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      getWindow().setDecorFitsSystemWindows(false);
      WindowInsetsController c = getWindow().getInsetsController();
      if (c != null) {
        c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
        c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
      }
    } else {
      getWindow()
          .getDecorView()
          .setSystemUiVisibility(
              View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                  | View.SYSTEM_UI_FLAG_FULLSCREEN
                  | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                  | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                  | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                  | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }
  }

  private void maybeShowSetupWizard() {
    SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    if (prefs.getBoolean(KEY_SETUP_DONE, false)) {
      return;
    }
    new AlertDialog.Builder(this)
        .setTitle("השלמת הרשאות (מומלץ)")
        .setMessage(
            "לנגן מסכים מומלץ:\n\n"
                + "• לאפשר ריצה ברקע ללא הגבלות סוללה\n"
                + "• במכשירים מסוימים: להפעיל \"הפעלה אוטומטית\" או \"הפעלה ברקע\" בהגדרות האפליקציה\n\n"
                + "לחצו קודם על «אפשר סוללה», ואם צריך — «הגדרות אפליקציה».")
        .setPositiveButton(
            "אפשר סוללה (מומלץ)",
            (d, which) -> requestBatteryOptimizationExemption())
        .setNeutralButton(
            "הגדרות אפליקציה",
            (d, which) -> openAppDetailsSettings())
        .setNegativeButton(
            "סיימתי — אל תציג שוב",
            (d, which) -> prefs.edit().putBoolean(KEY_SETUP_DONE, true).apply())
        .setOnCancelListener(
            d -> {
              /* משתמש סגר בלי «סיימתי» — בפעם הבאה יוצע שוב */
            })
        .setCancelable(true)
        .show();
  }

  private void requestBatteryOptimizationExemption() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
      openAppDetailsSettings();
      return;
    }
    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    if (pm == null) {
      openAppDetailsSettings();
      return;
    }
    if (pm.isIgnoringBatteryOptimizations(getPackageName())) {
      return;
    }
    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
    intent.setData(Uri.parse("package:" + getPackageName()));
    try {
      startActivity(intent);
    } catch (Exception e) {
      openAppDetailsSettings();
    }
  }

  private void openAppDetailsSettings() {
    Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
    intent.setData(Uri.parse("package:" + getPackageName()));
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
    try {
      startActivity(intent);
    } catch (Exception ignored) {
    }
  }
}
