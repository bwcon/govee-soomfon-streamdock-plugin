import os
from PIL import Image, ImageDraw, ImageFont

plugin_dir = r"d:\Coding Projects\Govee Soomfon Plugin"
img_dir = os.path.join(plugin_dir, "images")
actions_dir = os.path.join(img_dir, "actions")

def create_icon(path, text, bg_color="#1e1e1e", fg_color="#ffffff", size=(144,144)):
    img = Image.new('RGBA', size, (0,0,0,0))
    draw = ImageDraw.Draw(img)
    
    # Draw rounded rect
    draw.rounded_rectangle([0, 0, size[0], size[1]], radius=15, fill=bg_color)
    
    # Try to load a nice font, fallback to default
    try:
        font = ImageFont.truetype("arialbd.ttf", int(size[0]/5))
    except:
        font = ImageFont.load_default()
        
    # Draw centered text
    bbox = draw.textbbox((0,0), text, font=font)
    w = bbox[2] - bbox[0]
    h = bbox[3] - bbox[1]
    
    draw.text(((size[0]-w)/2, (size[1]-h)/2), text, font=font, fill=fg_color)
    img.save(path)

# Plugin icons
create_icon(os.path.join(img_dir, "plugin-icon.png"), "Govee", bg_color="#1E3A8A", fg_color="#3B82F6")
create_icon(os.path.join(img_dir, "category-icon.png"), "GOV", bg_color="#1E3A8A", fg_color="#3B82F6", size=(28,28))

# Action icons
create_icon(os.path.join(actions_dir, "power.png"), "PWR", bg_color="#2c3e50")
create_icon(os.path.join(actions_dir, "color.png"), "RGB", bg_color="#8e44ad")
create_icon(os.path.join(actions_dir, "brightness.png"), "BRI", bg_color="#f39c12")
create_icon(os.path.join(actions_dir, "dial.png"), "DIAL", bg_color="#16a085")

print("Generated Govee icons.")
