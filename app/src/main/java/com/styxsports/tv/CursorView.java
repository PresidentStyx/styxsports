package com.styxsports.tv;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.view.View;

/**
 * Draws a simple mouse-style pointer that is driven by the remote's D-pad.
 * The view is a transparent overlay that covers the whole activity.
 */
public class CursorView extends View {

    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final float radius;
    private float x = -1f;
    private float y = -1f;
    private boolean pressed;

    public CursorView(Context context) {
        super(context);
        float density = context.getResources().getDisplayMetrics().density;
        radius = 11f * density;

        fill.setStyle(Paint.Style.FILL);
        fill.setColor(Color.argb(220, 255, 255, 255));

        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(2.5f * density);
        stroke.setColor(Color.argb(230, 20, 20, 20));

        setClickable(false);
        setFocusable(false);
    }

    public float getCursorX() {
        return x;
    }

    public float getCursorY() {
        return y;
    }

    public float getRadius() {
        return radius;
    }

    public void setPosition(float newX, float newY) {
        x = newX;
        y = newY;
        invalidate();
    }

    public void setPressed(boolean isPressed) {
        pressed = isPressed;
        invalidate();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (x < 0 || y < 0) {
            x = w / 2f;
            y = h / 2f;
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (x < 0 || y < 0) return;
        float r = pressed ? radius * 0.7f : radius;
        canvas.drawCircle(x, y, r, fill);
        canvas.drawCircle(x, y, r, stroke);
        // Small centre dot so the click point is obvious.
        canvas.drawCircle(x, y, stroke.getStrokeWidth() * 0.9f, stroke);
    }
}
