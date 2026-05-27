# -*- coding: utf-8 -*-
import os, sys, time, json, argparse, warnings
import torch
import torchio as tio
import numpy as np
import SimpleITK as sitk
import nibabel as nib
import ants
from monai.networks.nets import SwinUNETR
from monai.inferers import sliding_window_inference

warnings.filterwarnings("ignore")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out_dir", required=True)
    parser.add_argument("--weights", required=True)
    args = parser.parse_args()

    sys.stdout = open(os.devnull, 'w')
    result = {"status": "error", "message": "Unknown error", "mask_path": None}

    temp_files = []

    try:
        os.makedirs(args.out_dir, exist_ok=True)

        # 1. LECTURA NATIVA ESTRICTA
        dicom_dir = args.input if os.path.isdir(args.input) else os.path.dirname(args.input)
        reader = sitk.ImageSeriesReader()
        dicom_names = reader.GetGDCMSeriesFileNames(dicom_dir)
        reader.SetFileNames(dicom_names)
        native_sitk = reader.Execute()

        nifti_in_path = os.path.join(args.out_dir, "input_vol_native.nii.gz")
        sitk.WriteImage(native_sitk, nifti_in_path)
        temp_files.append(nifti_in_path)

        # 1b. ANTs PREPROCESSING PIPELINE
        img = ants.image_read(nifti_in_path)
        img = ants.reorient_image2(img, orientation="RPI")
        img_n4 = ants.n4_bias_field_correction(img, shrink_factor=3)

        brain_mask = ants.get_mask(img_n4)

        img_stripped = img_n4 * brain_mask
        img_cropped = ants.crop_image(img_stripped, brain_mask)
        img_final = ants.n4_bias_field_correction(img_cropped, shrink_factor=2)

        preprocessed_nifti_path = os.path.join(args.out_dir, "ants_preprocessed.nii.gz")
        ants.image_write(img_final, preprocessed_nifti_path)
        temp_files.append(preprocessed_nifti_path)

        # 2. PREPARACIÓN PARA LA IA (TorchIO)
        subject = tio.Subject(mri=tio.ScalarImage(preprocessed_nifti_path))

        full_transform = tio.Compose([
            tio.Resample(1.0),
            tio.RescaleIntensity(out_min_max=(0, 1), percentiles=(0.1, 99.9), masking_method=lambda x: x > 0),
            tio.CropOrPad((160, 192, 160))
        ])
        subj_full = full_transform(subject)

        # 3. INFERENCIA RED NEURONAL
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        model = SwinUNETR(in_channels=1, out_channels=8, feature_size=24, use_checkpoint=False).to(device)
        model.load_state_dict(torch.load(args.weights, map_location=device))
        model.eval()

        input_tensor = subj_full.mri.data.unsqueeze(0).to(device)
        with torch.no_grad():
            logits = sliding_window_inference(
                input_tensor, roi_size=(96, 96, 96), sw_batch_size=4,
                predictor=model, overlap=0.5, mode="gaussian"
            )

        mask_array = torch.argmax(logits, dim=1, keepdim=True).to(torch.uint8)[0, 0].cpu().numpy()

        # 4. PROYECCIÓN MATEMÁTICA AL ESPACIO NATIVO
        pred_nifti = nib.Nifti1Image(mask_array, subj_full.mri.affine)
        temp_mask_path = os.path.join(args.out_dir, "temp_mask.nii.gz")
        nib.save(pred_nifti, temp_mask_path)
        temp_files.append(temp_mask_path)

        pred_sitk = sitk.ReadImage(temp_mask_path)
        resampler = sitk.ResampleImageFilter()
        resampler.SetReferenceImage(native_sitk)
        resampler.SetInterpolator(sitk.sitkNearestNeighbor)
        resampler.SetDefaultPixelValue(0)
        final_mask_sitk = resampler.Execute(pred_sitk)

        # 5. GUARDADO SEGURO
        mask_out_path = os.path.join(args.out_dir, f"MASK_FINAL_{int(time.time())}.nii.gz")
        sitk.WriteImage(final_mask_sitk, mask_out_path)

        result["status"] = "success"
        result["mask_path"] = mask_out_path

    except Exception as e:
        result["status"] = "error"
        result["message"] = str(e)

    finally:
        for tmp in temp_files:
            if tmp and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except Exception:
                    pass
        sys.stdout = sys.__stdout__
        print(json.dumps(result))

if __name__ == '__main__':
    main()
